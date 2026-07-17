// ============================================================
// After-Sales Reverse Flow — Ozon return → intercept → refund
// ============================================================

import type { DbAdapter } from "../db/connection.js";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { logger } from "@onzo/logger";
import { emitEvent, EVENT_KEYS } from "./notification-events.js";

// ---- Types ----

export interface ReturnOrder {
  postingNumber: string;
  storeId: string;
  returnReason: string;
  returnType: "full" | "partial";
  refundAmountRub: number;
  products: Array<{ sku: number; offerId: string; quantity: number; priceRub: number }>;
  createdAt: string;
}

export interface ReverseResult {
  success: boolean;
  postingNumber: string;
  step: string;
  freightIntercepted: boolean;
  refund1688Id?: string;
  refundAmountCny?: number;
  error?: string;
}

// ---- Service ----

export class AftersalesReverseService {
  constructor(private db: DbAdapter | null) {}

  /**
   * Handle Ozon return order — full reverse flow.
   * 1. Sync return order → local_orders
   * 2. Notify freight forwarder to intercept
   * 3. Auto-apply for 1688 refund
   * 4. Write back to finance
   */
  async handleReturn(ozonClient: OzonClient, order: ReturnOrder): Promise<ReverseResult> {
    const result: ReverseResult = { success: false, postingNumber: order.postingNumber, step: "init", freightIntercepted: false };

    if (!this.db) { result.error = "DB unavailable"; return result; }

    // Step 1: Update local_orders → cancelled/returned
    result.step = "update_status";
    await this.db.run(
      "UPDATE local_orders SET status = 'cancelled', updated_at = datetime('now') WHERE posting_number = ?",
      [order.postingNumber]
    );

    // Step 2: Notify freight forwarder to intercept
    result.step = "intercept";
    try {
      if (process.env.FREIGHT_FORWARDER_API_URL) {
        await fetch(`${process.env.FREIGHT_FORWARDER_API_URL}/api/parcels/intercept`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.FREIGHT_FORWARDER_API_KEY || ""}`,
          },
          body: JSON.stringify({ postingNumber: order.postingNumber, reason: order.returnReason }),
          signal: AbortSignal.timeout(10_000),
        });
        result.freightIntercepted = true;
      }
    } catch (err) {
      logger.warn({ postingNumber: order.postingNumber, err: (err as Error).message }, "Freight intercept failed");
    }

    // Step 3: Look up 1688 purchase for this Ozon order
    result.step = "find_purchase";
    const purchaseRows = await this.db.all<{ id: string; total_amount_cny: number; offer_1688_id: string }>(
      "SELECT id, total_amount_cny, offer_1688_id as offer_1688_id FROM purchase_1688 WHERE ozon_posting_number = ? AND payment_status = 'paid'",
      [order.postingNumber]
    );

    if (purchaseRows.length === 0) {
      result.error = "No matching 1688 purchase found";
      await emitEvent(EVENT_KEYS.PURCHASE_PAY_FAILED, {
        postingNumber: order.postingNumber,
        error: `退货拦截: 未找到对应1688采购单`,
        channel: "return",
      });
      return result;
    }

    const purchase = purchaseRows[0];

    // Step 4: Attempt 1688 refund (partial if partial return, full otherwise)
    result.step = "refund_1688";
    const refundAmountCny = order.returnType === "full"
      ? purchase.total_amount_cny
      : Math.round(purchase.total_amount_cny * 0.5); // partial = 50% estimate

    try {
      const { createRefund } = await import("./alibaba-openplatform.js");
      // Note: 1688 Open Platform refund API may not be available — fallback gracefully
      const refundResult = await createRefund?.({
        orderId: purchase.offer_1688_id || purchase.id,
        amountCny: refundAmountCny,
        reason: order.returnReason || "买家退货",
      }).catch(() => ({ success: false, errorMsg: "1688 refund API not available" } as const));

      if (refundResult && (refundResult as { success: boolean; refundId?: string }).success) {
        result.refund1688Id = (refundResult as { refundId?: string }).refundId || `RF-${Date.now()}`;
        result.refundAmountCny = refundAmountCny;

        // Update purchase_1688 → refunded
        await this.db.run(
          "UPDATE purchase_1688 SET payment_status = 'refunded', pay_error = '买家退货', updated_at = datetime('now') WHERE id = ?",
          [purchase.id]
        );

        logger.info({ postingNumber: order.postingNumber, refundCny: refundAmountCny }, "1688 refund applied");
      } else {
        // Mark for manual refund
        await this.db.run(
          "UPDATE purchase_1688 SET pay_error = ?, updated_at = datetime('now') WHERE id = ?",
          [`待人工退款: ¥${refundAmountCny}`, purchase.id]
        );
        await emitEvent(EVENT_KEYS.PURCHASE_PAY_FAILED, {
          postingNumber: order.postingNumber,
          error: `需人工处理1688退款 ¥${refundAmountCny}`,
          channel: "return_refund",
        });
      }
    } catch (err) {
      logger.error({ postingNumber: order.postingNumber, err: (err as Error).message }, "1688 refund failed, marked for manual");
    }

    // Step 5: Write back to finance (daily_sales adjustment)
    result.step = "finance_writeback";
    const today = new Date().toISOString().slice(0, 10);
    await this.db.run(
      `INSERT INTO daily_sales (date, orders, revenue_rub, profit_rub, avg_order_value, updated_at)
       VALUES (?, 0, 0, -?, 0, datetime('now'))
       ON CONFLICT(date) DO UPDATE SET profit_rub = profit_rub - ?, updated_at = datetime('now')`,
      [today, order.refundAmountRub, order.refundAmountRub]
    );

    result.success = true;
    await emitEvent("ORDER_CANCELLED" as never, {
      postingNumber: order.postingNumber,
    } as never);

    return result;
  }

  /** Sync Ozon return orders (called after Ozon webhook "order.cancelled" or "return") */
  async syncReturns(ozonClient: OzonClient, storeId = "store_1"): Promise<number> {
    if (!this.db) return 0;

    // Get cancelled/returned Ozon orders from last 7 days
    const rows = await this.db.all<{ posting_number: string }>(
      `SELECT posting_number FROM local_orders
       WHERE status = 'cancelled' AND updated_at > datetime('now', '-7 days')
       AND posting_number NOT IN (SELECT ozon_posting_number FROM purchase_1688 WHERE payment_status = 'refunded')`
    );

    let processed = 0;
    for (const r of rows) {
      try {
        await this.handleReturn(ozonClient, {
          postingNumber: r.posting_number,
          storeId,
          returnReason: "Ozon平台退货",
          returnType: "full",
          refundAmountRub: 0,
          products: [],
          createdAt: new Date().toISOString(),
        });
        processed++;
      } catch (err) {
        logger.error({ postingNumber: r.posting_number, err: (err as Error).message }, "Return sync failed");
      }
    }
    return processed;
  }
}
