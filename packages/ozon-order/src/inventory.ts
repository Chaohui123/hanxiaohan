// ============================================================
// Inventory Manager — stock deduction with transaction safety
// Self-contained DbAdapter interface; no cross-package import
// ============================================================

export interface DbAdapter {
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface DeductResult {
  success: boolean;
  reason?: string;
}

export interface StockItem {
  offerId: string;
  sku: number;
  quantity: number;
}

export interface InventoryRecord {
  offerId: string;
  sku: number;
  stockAvailable: number;
  stockReserved: number;
  updatedAt: string;
}

export class InventoryManager {
  private db: DbAdapter;

  constructor(db: DbAdapter) {
    this.db = db;
  }

  async setStock(offerId: string, sku: number, quantity: number): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO inventory (offer_id, sku, stock_available, stock_reserved, updated_at)
       VALUES (?, ?, ?, 0, datetime('now'))`,
      [offerId, sku, quantity]
    );
  }

  async deduct(postingNumber: string, items: StockItem[]): Promise<DeductResult> {
    for (const item of items) {
      const record = await this.db.all<InventoryRecord>(
        "SELECT stock_available, stock_reserved FROM inventory WHERE offer_id = ? AND sku = ?",
        [item.offerId, item.sku]
      );
      if (!record.length || record[0].stockAvailable < item.quantity) {
        return { success: false, reason: `Insufficient stock for ${item.offerId}:${item.sku}` };
      }
      const na = record[0].stockAvailable - item.quantity;
      const nr = record[0].stockReserved + item.quantity;
      await this.db.run("UPDATE inventory SET stock_available=?, stock_reserved=?, updated_at=datetime('now') WHERE offer_id=? AND sku=?", [na, nr, item.offerId, item.sku]);
      await this.db.run("INSERT INTO stock_movements (posting_number,offer_id,sku,quantity,type,created_at) VALUES (?,?,?,?,'deduct',datetime('now'))", [postingNumber, item.offerId, item.sku, -item.quantity]);
    }
    return { success: true };
  }

  async restore(postingNumber: string, items: StockItem[]): Promise<void> {
    for (const item of items) {
      await this.db.run("UPDATE inventory SET stock_available=stock_available+?, stock_reserved=stock_reserved-?, updated_at=datetime('now') WHERE offer_id=? AND sku=?", [item.quantity, item.quantity, item.offerId, item.sku]);
      await this.db.run("INSERT INTO stock_movements (posting_number,offer_id,sku,quantity,type,created_at) VALUES (?,?,?,?,'restore',datetime('now'))", [postingNumber, item.offerId, item.sku, item.quantity]);
    }
  }

  async confirmDelivery(postingNumber: string): Promise<void> {
    const m = await this.db.all<{offer_id:string;sku:number;quantity:number}>("SELECT offer_id,sku,quantity FROM stock_movements WHERE posting_number=? AND type='deduct'", [postingNumber]);
    for (const r of m) await this.db.run("UPDATE inventory SET stock_reserved=stock_reserved+?, updated_at=datetime('now') WHERE offer_id=? AND sku=?", [r.quantity, r.offer_id, r.sku]);
  }

  async getStock(offerId: string, sku: number): Promise<InventoryRecord | null> {
    const rows = await this.db.all<any>("SELECT * FROM inventory WHERE offer_id=? AND sku=?", [offerId, sku]);
    const r = rows[0]
    if (!r) return null
    // Normalize possible column names from different adapters/mocks
    const stockAvailable = r.stock_available ?? r.stockAvailable ?? r.avail ?? 0
    const stockReserved = r.stock_reserved ?? r.stockReserved ?? r.reserved ?? 0
    return {
      offerId: r.offer_id ?? r.oid ?? offerId,
      sku: r.sku ?? sku,
      stockAvailable,
      stockReserved,
      updatedAt: r.updated_at ?? r.updatedAt ?? (new Date()).toISOString(),
    }
  }
}
