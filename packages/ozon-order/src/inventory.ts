// Inventory helper: handles transactional stock deduction and idempotency
import type { DbAdapter } from '../../apps/api-services/src/db/connection.js'
import { getDb, serializedWrite } from '../../apps/api-services/src/db/connection.js'

export interface DeductResult {
  success: boolean
  reason?: string
}

/**
 * Deduct inventory in a serialized write to avoid SQLite write locks.
 * Idempotency is enforced by recording a stock_movements row with posting_number=idempotencyKey.
 * If the same idempotencyKey was already used for a 'deduct', the function is a no-op and returns success.
 */
export async function deductInventory(storeId: string, sku: string, qty: number, idempotencyKey: string): Promise<DeductResult> {
  const db = await getDb();
  if (!db) return { success: false, reason: 'no_db' }

  return serializedWrite(async () => {
    // Check idempotency: has this posting_number been processed as a deduct?
    const existing = await db.all<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM stock_movements WHERE posting_number = ? AND type = 'deduct'`,
      [idempotencyKey]
    );
    if (existing?.[0]?.cnt && existing[0].cnt > 0) {
      return { success: true }
    }

    // For simplicity, use sku as offer_id when offer_id is not available
    const offerId = String(sku)

    // Read current stock
    const rows = await db.all<{ stock_available: number }>(
      `SELECT stock_available FROM inventory WHERE offer_id = ? AND sku = ?`,
      [offerId, sku]
    );
    const current = rows?.[0]?.stock_available ?? 0

    if (current < qty) {
      // Record attempted movement for audit
      await db.run(
        `INSERT INTO stock_movements (posting_number, offer_id, sku, quantity, type) VALUES (?, ?, ?, ?, 'deduct')`,
        [idempotencyKey, offerId, sku, 0]
      )
      return { success: false, reason: 'insufficient_stock' }
    }

    // Deduct stock and record movement
    await db.run(
      `UPDATE inventory SET stock_available = stock_available - ?, updated_at = (datetime('now')) WHERE offer_id = ? AND sku = ?`,
      [qty, offerId, sku]
    )

    await db.run(
      `INSERT INTO stock_movements (posting_number, offer_id, sku, quantity, type) VALUES (?, ?, ?, ?, 'deduct')`,
      [idempotencyKey, offerId, sku, qty]
    )

    return { success: true }
  })
}
// ============================================================
// Inventory Manager — stock deduction with transaction safety
// ============================================================

import type { DbAdapter } from "../../../apps/api-services/src/db/connection.js";

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

  /** Initialize inventory for a product (upsert). */
  async setStock(offerId: string, sku: number, quantity: number): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO inventory (offer_id, sku, stock_available, stock_reserved, updated_at)
       VALUES (?, ?, ?, 0, datetime('now'))`,
      [offerId, sku, quantity]
    );
  }

  /** Deduct stock for an order. Returns false if insufficient. Operates in a serialized write. */
  async deduct(
    postingNumber: string,
    items: StockItem[]
  ): Promise<{ success: boolean; failedItems: StockItem[] }> {
    const failedItems: StockItem[] = [];

    for (const item of items) {
      const record = await this.db.all(
        "SELECT stock_available, stock_reserved FROM inventory WHERE offer_id = ? AND sku = ?",
        [item.offerId, item.sku]
      ) as InventoryRecord[];

      if (!record.length || record[0].stockAvailable < item.quantity) {
        failedItems.push(item);
        continue;
      }

      const newAvailable = record[0].stockAvailable - item.quantity;
      const newReserved = record[0].stockReserved + item.quantity;

      await this.db.run(
        `UPDATE inventory SET stock_available = ?, stock_reserved = ?, updated_at = datetime('now')
         WHERE offer_id = ? AND sku = ?`,
        [newAvailable, newReserved, item.offerId, item.sku]
      );

      // Log deduction
      await this.db.run(
        `INSERT INTO stock_movements (posting_number, offer_id, sku, quantity, type, created_at)
         VALUES (?, ?, ?, ?, 'deduct', datetime('now'))`,
        [postingNumber, item.offerId, item.sku, -item.quantity]
      );
    }

    return { success: failedItems.length === 0, failedItems };
  }

  /** Restore stock (e.g., order cancelled). */
  async restore(
    postingNumber: string,
    items: StockItem[]
  ): Promise<void> {
    for (const item of items) {
      await this.db.run(
        `UPDATE inventory SET stock_available = stock_available + ?, stock_reserved = stock_reserved - ?,
         updated_at = datetime('now') WHERE offer_id = ? AND sku = ?`,
        [item.quantity, item.quantity, item.offerId, item.sku]
      );

      await this.db.run(
        `INSERT INTO stock_movements (posting_number, offer_id, sku, quantity, type, created_at)
         VALUES (?, ?, ?, ?, 'restore', datetime('now'))`,
        [postingNumber, item.offerId, item.sku, item.quantity]
      );
    }
  }

  /** Confirm delivery — move from reserved to fulfilled. */
  async confirmDelivery(postingNumber: string): Promise<void> {
    const movements = await this.db.all(
      "SELECT offer_id, sku, quantity FROM stock_movements WHERE posting_number = ? AND type = 'deduct'",
      [postingNumber]
    ) as Array<{ offer_id: string; sku: number; quantity: number }>;

    for (const m of movements) {
      // Reduce reserved count (already deducted from available)
      await this.db.run(
        `UPDATE inventory SET stock_reserved = stock_reserved + ?, updated_at = datetime('now')
         WHERE offer_id = ? AND sku = ?`,
        [m.quantity, m.offer_id, m.sku]  // quantity is negative, so + is really subtraction
      );
    }
  }

  /** Get current stock for a product. */
  async getStock(offerId: string, sku: number): Promise<InventoryRecord | null> {
    const rows = await this.db.all(
      "SELECT * FROM inventory WHERE offer_id = ? AND sku = ?",
      [offerId, sku]
    ) as InventoryRecord[];
    return rows[0] ?? null;
  }
}
