// ============================================================
// Inventory Manager — SQLite-persisted with memory cache layer
// Cache: read-through, write-through, 30s TTL
// ============================================================

import { getDb, serializedWrite } from "../db/connection.js";
import { emitEvent, EVENT_KEYS } from "./notification-events.js";
import { logger } from "@onzo/logger";

export type AlertLevel = "normal" | "warning" | "critical";

export interface InventoryItem {
  offerId: string; sku: number;
  stockAvailable: number; stockReserved: number;
  safetyStock: number; reorderPoint: number;
  supplier: string; leadTimeDays: number; unitCostCny: number;
  lastUpdated: string;
}

export interface InventoryAlert {
  id?: number; sku: number; offerId: string;
  currentStock: number; safetyStock: number; reorderPoint: number;
  alertLevel: AlertLevel; suggestedOrderQuantity: number;
  estimatedArrivalDays: number; resolved: boolean;
}

export interface SupplierInfo {
  id: string; name: string; contact: string;
  leadTimeDays: number; reliability: number; products: string[];
}

// ---- Cache ----
const cache = new Map<string, { data: InventoryItem; expiresAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

function cacheKey(offerId: string, sku: number): string { return `${offerId}:${sku}`; }

export class InventoryManager {
  async getItem(offerId: string, sku: number): Promise<InventoryItem | null> {
    const key = cacheKey(offerId, sku);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const db = await getDb().catch(() => null);
    if (!db) return null;

    const rows = await db.all("SELECT * FROM inventory WHERE offer_id=? AND sku=?", [offerId, sku]) as Array<Record<string,unknown>>;
    if (rows.length === 0) return null;

    const item: InventoryItem = {
      offerId: rows[0].offer_id as string, sku: rows[0].sku as number,
      stockAvailable: (rows[0].stock_available ?? 0) as number,
      stockReserved: (rows[0].stock_reserved ?? 0) as number,
      safetyStock: 5, reorderPoint: 10, supplier: "default", leadTimeDays: 7, unitCostCny: 0,
      lastUpdated: (rows[0].updated_at as string) ?? new Date().toISOString(),
    };
    cache.set(key, { data: item, expiresAt: Date.now() + CACHE_TTL_MS });
    return item;
  }

  async setStock(offerId: string, sku: number, quantity: number): Promise<void> {
    const db = await getDb().catch(() => null);
    if (!db) return;

    await serializedWrite(() =>
      db.run("INSERT INTO inventory (offer_id,sku,stock_available,stock_reserved,updated_at) VALUES (?,?,?,0,NOW()) ON CONFLICT(offer_id, sku) DO UPDATE SET stock_available=EXCLUDED.stock_available, stock_reserved=0, updated_at=NOW()", [offerId, sku, quantity])
    );
    // Invalidate cache
    cache.delete(cacheKey(offerId, sku));

    // Async sync to Ozon (fire-and-forget — don't block local update)
    this.syncStockToOzon(offerId, sku, quantity).catch((err) => {
      logger.warn({ offerId, sku, err: (err as Error).message }, "Failed to sync stock to Ozon");
    });
  }

  async getAlerts(threshold = 5): Promise<InventoryAlert[]> {
    const db = await getDb().catch(() => null);
    if (!db) return [];

    const rows = await db.all("SELECT * FROM inventory WHERE stock_available < ?", [threshold]) as Array<Record<string,unknown>>;
    const alerts: InventoryAlert[] = [];

    for (const r of rows) {
      const stock = (r.stock_available ?? 0) as number;
      const level: AlertLevel = stock === 0 ? "critical" : stock < 3 ? "warning" : "normal";

      if (stock === 0) {
        emitEvent(EVENT_KEYS.STOCK_OUT, { sku: String(r.sku), offerId: String(r.offer_id), currentStock: "0" }).catch(() => {});
      }

      // Dedup: skip if unresolved alert already exists for this SKU+offer_id
      const existing = await db.all(
        "SELECT id FROM stock_alerts WHERE sku=? AND offer_id=? AND resolved=0 LIMIT 1",
        [r.sku, r.offer_id]
      ).catch(() => [] as Array<{ id: number }>);

      if (!existing || existing.length === 0) {
        const suggestedQty = Math.max(10, (10 - stock) * 2);
        await db.run(
          "INSERT INTO stock_alerts (sku, offer_id, alert_level, current_stock, safety_stock, suggested_order_qty) VALUES (?,?,?,?,?,?)",
          [r.sku, r.offer_id, level, stock, 5, suggestedQty]
        ).catch(() => {});
      }

      alerts.push({
        sku: r.sku as number, offerId: r.offer_id as string,
        currentStock: stock, safetyStock: 5, reorderPoint: 10,
        alertLevel: level, suggestedOrderQuantity: Math.max(10, (10 - stock) * 2),
        estimatedArrivalDays: 7, resolved: false,
      });
    }
    return alerts;
  }

  async getAllItems(): Promise<InventoryItem[]> {
    const db = await getDb().catch(() => null);
    if (!db) return [];
    const rows = await db.all("SELECT * FROM inventory ORDER BY offer_id") as Array<Record<string,unknown>>;
    return rows.map(r => ({
      offerId: r.offer_id as string, sku: r.sku as number,
      stockAvailable: (r.stock_available ?? 0) as number, stockReserved: (r.stock_reserved ?? 0) as number,
      safetyStock: 5, reorderPoint: 10, supplier: "default", leadTimeDays: 7, unitCostCny: 0,
      lastUpdated: (r.updated_at as string) ?? new Date().toISOString(),
    }));
  }

  /** Alias for setStock — update stock level */
  async updateStock(offerId: string, sku: number, quantity: number): Promise<void> {
    return this.setStock(offerId, sku, quantity);
  }

  /** Reserve stock (decrement available) */
  async reserveStock(offerId: string, sku: number, quantity: number): Promise<void> {
    const db = await getDb().catch(() => null);
    if (!db) return;
    await serializedWrite(() =>
      db.run("UPDATE inventory SET stock_available = stock_available - ?, stock_reserved = stock_reserved + ? WHERE offer_id=? AND sku=? AND stock_available >= ?",
        [quantity, quantity, offerId, sku, quantity])
    );
    cache.delete(cacheKey(offerId, sku));
  }

  /** Release reserved stock */
  async releaseStock(offerId: string, sku: number, quantity: number): Promise<void> {
    const db = await getDb().catch(() => null);
    if (!db) return;
    await serializedWrite(() =>
      db.run("UPDATE inventory SET stock_available = stock_available + ?, stock_reserved = stock_reserved - ? WHERE offer_id=? AND sku=?",
        [quantity, quantity, offerId, sku])
    );
    cache.delete(cacheKey(offerId, sku));
  }

  /** Get all supplier info */
  async getSuppliers(): Promise<SupplierInfo[]> {
    return [{ id: "default", name: "Default Supplier", contact: "", leadTimeDays: 7, reliability: 1.0, products: [] }];
  }

  /** Get reorder recommendations based on current stock levels */
  async getReorderRecommendations(): Promise<InventoryAlert[]> {
    return this.getAlerts(5);
  }

  /** Calculate total inventory value */
  async getInventoryValue(): Promise<{ totalValueCny: number; itemCount: number }> {
    const items = await this.getAllItems();
    const total = items.reduce((sum, i) => sum + i.stockAvailable * i.unitCostCny, 0);
    return { totalValueCny: total, itemCount: items.length };
  }

  /** Add a new supplier */
  async addSupplier(_info: Omit<SupplierInfo, "id">): Promise<SupplierInfo> {
    return { id: `supplier_${Date.now()}`, ..._info };
  }

  /** Add a new inventory item */
  async addItem(item: Omit<InventoryItem, "lastUpdated">): Promise<InventoryItem> {
    const db = await getDb().catch(() => null);
    if (db) {
      await serializedWrite(() =>
        db.run("INSERT INTO inventory (offer_id,sku,stock_available,stock_reserved,updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(offer_id,sku) DO UPDATE SET stock_available=?,stock_reserved=?,updated_at=datetime('now')",
          [item.offerId, item.sku, item.stockAvailable, item.stockReserved, item.stockAvailable, item.stockReserved])
      );
    }
    return { ...item, lastUpdated: new Date().toISOString() };
  }

  /**
   * Sync local inventory stock level back to Ozon warehouse.
   * Called after local stock changes to keep Ozon in sync.
   */
  async syncStockToOzon(offerId: string, sku: number, stock: number): Promise<{ success: boolean; error?: string }> {
    try {
      const db = await getDb();
      if (!db) return { success: false, error: "DB unavailable" };

      const storeRows = await db.all(
        "SELECT client_id, api_key FROM store_configs WHERE store_id = 'store_1' AND active = 1 LIMIT 1"
      ) as Array<{ client_id: string; api_key: string }>;

      if (!storeRows.length) return { success: false, error: "No active store credentials configured" };

      // warehouse_id: default from env var, Ozon requires it for /v2/product/stocks
      const warehouseId = parseInt(process.env.OZON_WAREHOUSE_ID || "0", 10) || undefined;

      const { isEncrypted, decrypt } = await import("./crypto.js");
      const { AuthManager, OzonClient } = await import("@onzo/ozon-api-wrapper");

      const store = storeRows[0];
      const apiKey = isEncrypted(store.api_key) ? decrypt(store.api_key) : store.api_key;
      const auth = new AuthManager({ clients: [{ clientId: store.client_id, apiKey }] });
      const ozonClient = new OzonClient({ auth });

      // Push stock to Ozon warehouse — warehouse_id is required by Ozon API
      await ozonClient.updateStock([{ offerId, stock, warehouseId }]);

      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}
