// ============================================================
// Freight Forwarder Service — tracking ingestion + Ozon backfill
// 货代收到包裹 → 验货打包 → 获取国际跟踪号 → 回填Ozon
// ============================================================

import type { DbAdapter } from "../db/connection.js";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { OzonOrderClient } from "@onzo/ozon-order";
import { logger } from "@onzo/logger";
import { emitEvent, EVENT_KEYS } from "./notification-events.js";
import { cache } from "@onzo/cache";

// ---- Types ----

export interface TrackingInput {
  postingNumber: string;       // Ozon posting number
  trackingNumber: string;      // International tracking number (from freight forwarder)
  carrier?: string;            // Carrier name (CDEK, Russian Post, etc.)
  weightGrams?: number;        // Actual package weight
  notes?: string;              // Freight forwarder notes
}

export interface BackfillResult {
  success: boolean;
  postingNumber: string;
  trackingNumber: string;
  ozonShipped: boolean;
  error?: string;
}

export interface LogisticsDelayAlert {
  postingNumber: string;
  hoursSincePurchase: number;
  amountCny: number;
  purchaseId: string;
}

// ---- Service ----

export class FreightForwarderService {
  constructor(private db: DbAdapter | null) {}

  /**
   * Receive tracking number from freight forwarder and backfill to Ozon.
   * This is the main entry point — called when 货代 provides the international tracking number.
   */
  async ingestTracking(ozonClient: OzonClient, input: TrackingInput): Promise<BackfillResult> {
    const result: BackfillResult = {
      success: false,
      postingNumber: input.postingNumber,
      trackingNumber: input.trackingNumber,
      ozonShipped: false,
    };

    if (!this.db) {
      result.error = "DB unavailable";
      return result;
    }

    // 1. Update purchase_1688 with tracking info
    await this.db.run(
      `UPDATE purchase_1688 SET logistics_status = 'shipped', logistics_tracking = ?, updated_at = datetime('now')
       WHERE ozon_posting_number = ? AND payment_status = 'paid'`,
      [input.trackingNumber, input.postingNumber]
    );

    // 2. Update ozon_orders with tracking
    await this.db.run(
      `UPDATE ozon_orders SET tracking_number = ?, updated_at = datetime('now')
       WHERE posting_number = ?`,
      [input.trackingNumber, input.postingNumber]
    ).catch(() => {});

    // 3. Call Ozon ship API to backfill tracking number
    try {
      const orderClient = new OzonOrderClient(ozonClient);

      // Get SKU list from purchase record
      const purchaseRows = await this.db.all<{ sku_list_json: string }>(
        "SELECT sku_list_json FROM purchase_1688 WHERE ozon_posting_number = ?",
        [input.postingNumber]
      );

      const skuList = purchaseRows.length > 0
        ? JSON.parse(purchaseRows[0].sku_list_json || "[]") as Array<{ sku: number; quantity: number }>
        : [{ sku: 0, quantity: 1 }]; // fallback

      await orderClient.shipOrder(input.postingNumber, input.trackingNumber, skuList);
      result.ozonShipped = true;

      // 4. Update local_orders status
      await this.db.run(
        `UPDATE local_orders SET status = 'delivering', tracking_number = ?, updated_at = datetime('now')
         WHERE posting_number = ?`,
        [input.trackingNumber, input.postingNumber]
      ).catch(() => {});

      // 5. Notify
      await emitEvent(EVENT_KEYS.ORDER_SHIPPED, {
        postingNumber: input.postingNumber,
        trackingNumber: input.trackingNumber,
      });
      await emitEvent("LOGISTICS_PICKUP_CONFIRMED", {
        postingNumber: input.postingNumber,
        trackingNumber: input.trackingNumber,
        carrier: input.carrier || "auto",
      } as never);

      // 6. Cache the tracking
      await cache.cachedSet("logistics", `tracking:${input.postingNumber}`, input, 86400 * 30);

      logger.info({ postingNumber: input.postingNumber, tracking: input.trackingNumber, carrier: input.carrier }, "FreightForwarder: tracking backfilled to Ozon");
      result.success = true;
    } catch (err) {
      result.error = (err as Error).message;
      await emitEvent(EVENT_KEYS.SHIPMENT_FAILED, {
        postingNumber: input.postingNumber,
        error: result.error,
      });
      logger.error({ postingNumber: input.postingNumber, err: result.error }, "FreightForwarder: Ozon ship API failed");
    }

    return result;
  }

  /** Batch ingest multiple tracking numbers */
  async ingestBatch(ozonClient: OzonClient, inputs: TrackingInput[]): Promise<BackfillResult[]> {
    const results: BackfillResult[] = [];
    for (const input of inputs) {
      results.push(await this.ingestTracking(ozonClient, input));
    }
    return results;
  }

  /**
   * Check for logistics delays — purchases paid but not shipped for > 48 hours.
   * Called by scheduled job. Sends TG alert for delayed orders.
   */
  async checkLogisticsDelays(): Promise<LogisticsDelayAlert[]> {
    if (!this.db) return [];

    const rows = await this.db.all<{ posting_number: string; total_amount_cny: number; id: string; pay_time: string }>(
      `SELECT ozon_posting_number as posting_number, total_amount_cny, id, pay_time
       FROM purchase_1688
       WHERE payment_status = 'paid' AND logistics_status = 'idle'
       AND pay_time IS NOT NULL
       AND datetime(pay_time) < datetime('now', '-48 hours')`
    );

    const alerts: LogisticsDelayAlert[] = [];
    for (const r of rows) {
      const hoursSincePurchase = r.pay_time
        ? Math.round((Date.now() - new Date(r.pay_time).getTime()) / 3600000)
        : 0;

      alerts.push({
        postingNumber: r.posting_number,
        hoursSincePurchase,
        amountCny: r.total_amount_cny,
        purchaseId: r.id,
      });

      await emitEvent("LOGISTICS_DELAY" as never, {
        postingNumber: r.posting_number,
        hours: String(hoursSincePurchase),
        amountCny: String(r.total_amount_cny),
      } as never);
    }

    if (alerts.length > 0) {
      logger.warn({ delayedCount: alerts.length }, "FreightForwarder: logistics delays detected");
    }

    return alerts;
  }

  /** Get tracking info for a posting number */
  async getTracking(postingNumber: string): Promise<TrackingInput | null> {
    return cache.cachedGet<TrackingInput>("logistics", `tracking:${postingNumber}`);
  }
}
