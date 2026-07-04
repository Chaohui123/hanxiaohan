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
      `INSERT INTO inventory (offer_id, sku, stock_available, stock_reserved, updated_at)
       VALUES (?, ?, ?, 0, NOW()) ON CONFLICT(offer_id, sku) DO UPDATE SET stock_available=EXCLUDED.stock_available, updated_at=NOW()`,
      [offerId, sku, quantity]
    );
  }

  async deduct(postingNumber: string, items: StockItem[]): Promise<DeductResult> {
    // Validate all items have sufficient stock BEFORE starting transaction
    for (const item of items) {
      const rows = await this.db.all<Record<string, unknown>>(
        "SELECT stock_available, stock_reserved FROM inventory WHERE offer_id = ? AND sku = ?",
        [item.offerId, item.sku]
      );
      const row = rows[0];
      // Support both snake_case (real SQLite) and camelCase (mock adapters)
      const stockAvailable = (row?.stock_available ?? row?.stockAvailable ?? row?.avail ?? 0) as number;
      if (!row || stockAvailable < item.quantity) {
        return { success: false, reason: `Insufficient stock for ${item.offerId}:${item.sku}` };
      }
    }

    // Execute all deductions in a single transaction (BEGIN/COMMIT)
    // If any step fails, the entire batch is rolled back
    await this.db.run("BEGIN");
    try {
      for (const item of items) {
        const rows = await this.db.all<Record<string, unknown>>(
          "SELECT stock_available, stock_reserved FROM inventory WHERE offer_id = ? AND sku = ?",
          [item.offerId, item.sku]
        );
        const row = rows[0];
        const stockAvailable = (row?.stock_available ?? row?.stockAvailable ?? row?.avail ?? 0) as number;
        const stockReserved = (row?.stock_reserved ?? row?.stockReserved ?? row?.reserved ?? 0) as number;

        // Re-check under transaction lock
        if (!row || stockAvailable < item.quantity) {
          throw new Error(`Insufficient stock for ${item.offerId}:${item.sku}`);
        }

        const na = stockAvailable - item.quantity;
        const nr = stockReserved + item.quantity;
        await this.db.run(
          "UPDATE inventory SET stock_available=?, stock_reserved=?, updated_at=NOW() WHERE offer_id=? AND sku=?",
          [na, nr, item.offerId, item.sku]
        );
        await this.db.run(
          "INSERT INTO stock_movements (posting_number,offer_id,sku,quantity,type,created_at) VALUES (?,?,?,?,'deduct',NOW())",
          [postingNumber, item.offerId, item.sku, -item.quantity]
        );
      }
      await this.db.run("COMMIT");
      return { success: true };
    } catch (err) {
      await this.db.run("ROLLBACK").catch(() => {});
      if (err instanceof Error) {
        return { success: false, reason: err.message };
      }
      return { success: false, reason: String(err) };
    }
  }

  async restore(postingNumber: string, items: StockItem[]): Promise<void> {
    for (const item of items) {
      await this.db.run("UPDATE inventory SET stock_available=stock_available+?, stock_reserved=stock_reserved-?, updated_at=NOW() WHERE offer_id=? AND sku=?", [item.quantity, item.quantity, item.offerId, item.sku]);
      await this.db.run("INSERT INTO stock_movements (posting_number,offer_id,sku,quantity,type,created_at) VALUES (?,?,?,?,'restore',NOW())", [postingNumber, item.offerId, item.sku, item.quantity]);
    }
  }

  async confirmDelivery(postingNumber: string): Promise<void> {
    const m = await this.db.all<{offer_id:string;sku:number;quantity:number}>("SELECT offer_id,sku,quantity FROM stock_movements WHERE posting_number=? AND type='deduct'", [postingNumber]);
    for (const r of m) await this.db.run("UPDATE inventory SET stock_reserved=stock_reserved+?, updated_at=NOW() WHERE offer_id=? AND sku=?", [r.quantity, r.offer_id, r.sku]);
  }

  async getStock(offerId: string, sku: number): Promise<InventoryRecord | null> {
    const rows = await this.db.all<InventoryRecord>("SELECT * FROM inventory WHERE offer_id=? AND sku=?", [offerId, sku]);
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
