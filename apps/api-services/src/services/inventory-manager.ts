// ============================================================
// Inventory Manager — SQLite-persisted with memory cache layer
// Cache: read-through, write-through, 30s TTL
// ============================================================

import { getDb, serializedWrite } from "../db/connection.js";
import { emitEvent, EVENT_KEYS } from "./notification-events.js";

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
      db.run("INSERT OR REPLACE INTO inventory (offer_id,sku,stock_available,stock_reserved,updated_at) VALUES (?,?,?,0,datetime('now'))", [offerId, sku, quantity])
    );
    // Invalidate cache
    cache.delete(cacheKey(offerId, sku));
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

      // Persist alert to stock_alerts table
      await db.run(
        "INSERT INTO stock_alerts (sku, offer_id, alert_level, current_stock, safety_stock, suggested_order_qty) VALUES (?,?,?,?,?,?)",
        [r.sku, r.offer_id, level, stock, 5, Math.max(10, (10 - stock) * 2)]
      ).catch(() => {});

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
}
