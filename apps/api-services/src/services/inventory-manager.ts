// ============================================================
// Inventory Manager — SQLite-persisted stock tracking
// Survives restarts. Backed by the `inventory` + `stock_movements` tables
// ============================================================

import { getDb, serializedWrite } from "../db/connection.js";
import { logger } from "@onzo/logger";

export type AlertLevel = "normal" | "warning" | "critical";

export interface InventoryItem {
  offerId: string;
  sku: number;
  stockAvailable: number;
  stockReserved: number;
  safetyStock: number;
  reorderPoint: number;
  supplier: string;
  leadTimeDays: number;
  unitCostCny: number;
  lastUpdated: string;
}

export interface InventoryAlert {
  sku: number;
  offerId: string;
  currentStock: number;
  safetyStock: number;
  reorderPoint: number;
  alertLevel: AlertLevel;
  suggestedOrderQuantity: number;
  estimatedArrivalDays: number;
}

export interface SupplierInfo {
  id: string;
  name: string;
  baseUrl: string;
  reliability: number;
  avgLeadTimeDays: number;
  minOrderQuantity: number;
}

export interface ReorderRecommendation {
  sku: number;
  offerId: string;
  currentStock: number;
  safetyStock: number;
  reorderQuantity: number;
  unitCostCny: number;
  totalCostCny: number;
  suppliers: SupplierInfo[];
  bestSupplier: SupplierInfo | null;
}

export class InventoryManager {
  private suppliers = new Map<string, SupplierInfo>();

  constructor() {
    // Pre-populate default suppliers (replace with real data in production)
    this.suppliers.set("default", {
      id: "default", name: "1688 Default", baseUrl: "https://detail.1688.com",
      reliability: 0.85, avgLeadTimeDays: 7, minOrderQuantity: 10,
    });
  }

  /** Get inventory for a product — from SQLite */
  async getItem(offerId: string, sku: number): Promise<InventoryItem | null> {
    const db = await getDb().catch(() => null);
    if (!db) return null;

    const rows = await db.all(
      "SELECT offer_id, sku, stock_available, stock_reserved, updated_at FROM inventory WHERE offer_id = ? AND sku = ?",
      [offerId, sku]
    ) as Array<Record<string, unknown>>;

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      offerId: r.offer_id as string,
      sku: r.sku as number,
      stockAvailable: (r.stock_available ?? 0) as number,
      stockReserved: (r.stock_reserved ?? 0) as number,
      safetyStock: 5,
      reorderPoint: 10,
      supplier: "default",
      leadTimeDays: 7,
      unitCostCny: 0,
      lastUpdated: (r.updated_at as string) ?? new Date().toISOString(),
    };
  }

  /** Set stock level — persisted to SQLite */
  async setStock(offerId: string, sku: number, quantity: number): Promise<void> {
    const db = await getDb().catch(() => null);
    if (!db) return;

    await serializedWrite(() =>
      db.run(
        "INSERT OR REPLACE INTO inventory (offer_id, sku, stock_available, stock_reserved, updated_at) VALUES (?, ?, ?, 0, datetime('now'))",
        [offerId, sku, quantity]
      )
    );
  }

  /** Get all low-stock alerts — from SQLite */
  async getAlerts(threshold = 5): Promise<InventoryAlert[]> {
    const db = await getDb().catch(() => null);
    if (!db) return [];

    const rows = await db.all(
      "SELECT offer_id, sku, stock_available FROM inventory WHERE stock_available < ?",
      [threshold]
    ) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const stock = (r.stock_available ?? 0) as number;
      return {
        offerId: r.offer_id as string,
        sku: r.sku as number,
        currentStock: stock,
        safetyStock: 5,
        reorderPoint: 10,
        alertLevel: (stock === 0 ? "critical" : stock < 3 ? "warning" : "normal") as AlertLevel,
        suggestedOrderQuantity: Math.max(10, (10 - stock) * 2),
        estimatedArrivalDays: 7,
      };
    });
  }

  /** Generate reorder recommendations */
  async getReorderRecommendations(): Promise<ReorderRecommendation[]> {
    const alerts = await this.getAlerts(10);
    const supplier = this.suppliers.get("default");

    return alerts.map((a) => ({
      sku: a.sku,
      offerId: a.offerId,
      currentStock: a.currentStock,
      safetyStock: a.safetyStock,
      reorderQuantity: a.suggestedOrderQuantity,
      unitCostCny: 0,
      totalCostCny: 0,
      suppliers: supplier ? [supplier] : [],
      bestSupplier: supplier ?? null,
    }));
  }

  /** Get all inventory items */
  async getAllItems(): Promise<InventoryItem[]> {
    const db = await getDb().catch(() => null);
    if (!db) return [];

    const rows = await db.all(
      "SELECT offer_id, sku, stock_available, stock_reserved, updated_at FROM inventory ORDER BY offer_id"
    ) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      offerId: r.offer_id as string,
      sku: r.sku as number,
      stockAvailable: (r.stock_available ?? 0) as number,
      stockReserved: (r.stock_reserved ?? 0) as number,
      safetyStock: 5,
      reorderPoint: 10,
      supplier: "default",
      leadTimeDays: 7,
      unitCostCny: 0,
      lastUpdated: (r.updated_at as string) ?? new Date().toISOString(),
    }));
  }

  /** Upsert a supplier */
  upsertSupplier(info: SupplierInfo): void {
    this.suppliers.set(info.id, info);
    logger.info({ supplierId: info.id }, "Supplier registered");
  }
}
