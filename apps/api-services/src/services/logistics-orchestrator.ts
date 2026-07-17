// ============================================================
// Logistics Orchestrator — unified shipment creation, tracking,
// monitoring, and cost writeback across multiple carriers.
//
// Lifecycle:
//   1. 1688 payment confirmed → createShipment() via Redis lock
//   2. CDEK/Boxberry/RussianPost webhook → updateTracking()
//   3. Scheduler: checkDelays() every 30min → TG alerts
//   4. Finance: getShipmentCost() writes to reconciliation
// ============================================================

import type { DbAdapter } from "../db/connection.js";
import { serializedWrite } from "../db/connection.js";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { OzonOrderClient } from "@onzo/ozon-order";
import {
  getLogisticsProvider,
  type LogisticsProvider,
  type ShipmentRequest,
  type ShipmentResult,
} from "@onzo/logistics";
import { logger } from "@onzo/logger";
import { notifier } from "./notifier.js";
import { acquireLock, releaseLock } from "./redis-lock.js";
import { emitEvent, EVENT_KEYS } from "./notification-events.js";

// ---- Types ----

export interface CreateShipmentInput {
  postingNumber: string;
  purchaseId: string;
  storeId?: string;
  recipientName?: string;
  recipientPhone?: string;
  address?: { city: string; street: string; zipCode: string; country?: string };
  packageWeightGrams?: number;
  packageItems?: Array<{ name: string; quantity: number; priceRub: number }>;
  deliveryType?: "courier" | "pickup";
}

export interface ShipmentRecord {
  postingNumber: string;
  trackingNumber: string;
  carrier: string;
  costRub: number;
  status: string;
  created: string;
  updated: string;
  labelUrl?: string;
}

export interface TrackingWebhook {
  trackingNumber: string;
  status: string;
  statusDescription: string;
  timestamp: string;
  location?: string;
  carrier: string;
}

export interface DiagnoseResult {
  totalShipments: number;
  byCarrier: Record<string, number>;
  byStatus: Record<string, number>;
  delayedCount: number;
  delayedOrders: Array<{ postingNumber: string; hoursSincePayment: number; carrier: string }>;
  averageCostByCarrier: Record<string, number>;
  recentTrackingUpdates: Array<{ postingNumber: string; trackingNumber: string; status: string; updated: string }>;
}

// ---- Service ----

export class LogisticsOrchestrator {
  constructor(private db: DbAdapter | null) {}

  // ==============================================================
  // Shipment Creation
  // ==============================================================

  /**
   * Create a logistics shipment from 1688 purchase data.
   * Uses Redis distributed lock to prevent duplicate submission.
   */
  async createShipment(input: CreateShipmentInput): Promise<ShipmentResult> {
    if (!this.db) return { success: false, provider: "none", error: "DB unavailable" };

    // Redis lock: prevent duplicate shipment creation for same posting
    const lockToken = await acquireLock(`shipment:${input.postingNumber}`, 120);
    if (!lockToken) {
      return { success: false, provider: "none", error: "Duplicate: shipment already in progress" };
    }

    try {
      // 1. Get purchase record for details
      const purchases = await this.db.all<{
        id: string; ozon_posting_number: string; sku_list_json: string;
        total_amount_cny: number; store_id: string;
      }>(
        "SELECT * FROM purchase_1688 WHERE ozon_posting_number = ? AND payment_status = 'paid'",
        [input.postingNumber]
      );

      if (purchases.length === 0) {
        return { success: false, provider: "none", error: "Purchase not found or not paid" };
      }

      const purchase = purchases[0]!;
      const skuList: Array<{ sku: number; quantity: number }> = JSON.parse(purchase.sku_list_json || "[]");

      // 2. Get SKU mapping for weight + address
      interface SkuMappingRow { freight_address: string; weight_kg: number; ozon_offer_id: string; }
      const skuMappings = await this.db.all<SkuMappingRow>(
        "SELECT freight_address, weight_kg, ozon_offer_id FROM sku_1688_mapping WHERE ozon_posting_number = ? LIMIT 1",
        [input.postingNumber]
      ).catch((): SkuMappingRow[] => []);

      const mapping = skuMappings[0];
      const weightGrams = input.packageWeightGrams || (mapping?.weight_kg || 0.3) * 1000;

      // 3. Get Ozon order for recipient info
      interface OzonOrderRow { buyer_name: string; buyer_phone: string; products_json: string; total_price_rub: number; }
      const ozonOrders = await this.db.all<OzonOrderRow>(
        "SELECT buyer_name, buyer_phone, products_json, total_price_rub FROM ozon_orders WHERE posting_number = ?",
        [input.postingNumber]
      ).catch((): OzonOrderRow[] => []);

      const ozonOrder = ozonOrders[0];
      const productsJson = ozonOrder?.products_json
        ? (JSON.parse(ozonOrder.products_json) as Array<{ name?: string; offer_id?: string; price?: number; quantity: number }>)
        : [];

      // 4. Build shipment request
      const shipmentRequest: ShipmentRequest = {
        postingNumber: input.postingNumber,
        recipientName: input.recipientName || ozonOrder?.buyer_name || "",
        recipientPhone: input.recipientPhone || ozonOrder?.buyer_phone || "",
        address: input.address || {
          city: "Москва",
          street: mapping?.freight_address || "",
          zipCode: "101000",
          country: "RU",
        },
        package: {
          weightGrams: Math.round(weightGrams),
          lengthCm: 30,
          widthCm: 20,
          heightCm: 15,
          items: input.packageItems?.length
            ? input.packageItems
            : productsJson.map((p) => ({
                name: p.name || p.offer_id || "товар",
                quantity: p.quantity || 1,
                priceRub: p.price || ozonOrder?.total_price_rub || 0,
              })),
        },
        deliveryType: input.deliveryType || "courier",
      };

      // 5. Call logistics provider
      const provider = await getLogisticsProvider();
      if (!provider) {
        return { success: false, provider: "none", error: "No logistics provider available" };
      }

      const shipmentResult = await provider.createShipment(shipmentRequest);

      // 6. Persist shipment record
      if (shipmentResult.success && shipmentResult.trackingNumber) {
        await serializedWrite(() =>
          this.db!.run(
            `UPDATE purchase_1688
             SET logistics_status = 'shipped',
                 logistics_tracking = ?,
                 logistics_carrier = ?,
                 logistics_cost_rub = ?,
                 logistics_label_url = ?,
                 logistics_created_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE ozon_posting_number = ?`,
            [
              shipmentResult.trackingNumber,
              provider.name,
              Math.round(shipmentResult.costRub || 0),
              shipmentResult.labelUrl || "",
              input.postingNumber,
            ]
          )
        );

        // 7. Backfill to Ozon
        try {
          await this.db.run(
            `UPDATE ozon_orders SET tracking_number = ?, updated_at = datetime('now')
             WHERE posting_number = ?`,
            [shipmentResult.trackingNumber, input.postingNumber]
          );
        } catch {}

        // 8. Notify
        await emitEvent(EVENT_KEYS.ORDER_SHIPPED, {
          postingNumber: input.postingNumber,
          trackingNumber: shipmentResult.trackingNumber,
        });
        await emitEvent("LOGISTICS_PICKUP_CONFIRMED" as never, {
          postingNumber: input.postingNumber,
          trackingNumber: shipmentResult.trackingNumber,
          carrier: provider.name,
        } as never);

        logger.info({
          postingNumber: input.postingNumber,
          trackingNumber: shipmentResult.trackingNumber,
          carrier: provider.name,
          costRub: shipmentResult.costRub,
        }, "LogisticsOrchestrator: shipment created");
      } else {
        logger.error({
          postingNumber: input.postingNumber,
          error: shipmentResult.error,
          carrier: provider.name,
        }, "LogisticsOrchestrator: shipment creation failed");
      }

      return shipmentResult;
    } catch (err) {
      logger.error({ err: (err as Error).message, postingNumber: input.postingNumber }, "LogisticsOrchestrator: createShipment error");
      return { success: false, provider: "unknown", error: (err as Error).message };
    } finally {
      await releaseLock(`shipment:${input.postingNumber}`, lockToken!).catch(() => {});
    }
  }

  /**
   * Batch create shipments for all paid purchases without tracking.
   * Called by scheduler or manual trigger.
   */
  async batchCreateShipments(ozonClient: OzonClient): Promise<{ total: number; succeeded: number; failed: number }> {
    if (!this.db) return { total: 0, succeeded: 0, failed: 0 };

    const pendingPurchases = await this.db.all<{
      ozon_posting_number: string; id: string; store_id: string;
    }>(
      `SELECT ozon_posting_number, id, store_id
       FROM purchase_1688
       WHERE payment_status = 'paid'
       AND (logistics_status = 'idle' OR logistics_status IS NULL)
       AND (logistics_tracking IS NULL OR logistics_tracking = '')
       ORDER BY pay_time ASC
       LIMIT 50`
    );

    let succeeded = 0;
    let failed = 0;

    for (const purchase of pendingPurchases) {
      const result = await this.createShipment({
        postingNumber: purchase.ozon_posting_number,
        purchaseId: purchase.id,
        storeId: purchase.store_id,
      });
      if (result.success) succeeded++;
      else failed++;
    }

    logger.info({ total: pendingPurchases.length, succeeded, failed }, "LogisticsOrchestrator: batch shipment complete");
    return { total: pendingPurchases.length, succeeded, failed };
  }

  // ==============================================================
  // Tracking Webhook
  // ==============================================================

  /**
   * Process incoming tracking webhook from CDEK/Boxberry/RussianPost.
   * Updates purchase_1688 logistics_status in real time.
   */
  async processWebhook(webhook: TrackingWebhook): Promise<void> {
    if (!this.db) return;

    logger.info({
      trackingNumber: webhook.trackingNumber,
      status: webhook.status,
      carrier: webhook.carrier,
    }, "LogisticsOrchestrator: webhook received");

    // Map carrier status to internal status
    const internalStatus = this.mapCarrierStatus(webhook.status, webhook.carrier);

    await serializedWrite(() =>
      this.db!.run(
        `UPDATE purchase_1688
         SET logistics_status = ?,
             logistics_last_event = ?,
             logistics_last_event_at = ?,
             updated_at = datetime('now')
         WHERE logistics_tracking = ?`,
        [internalStatus, webhook.statusDescription, webhook.timestamp, webhook.trackingNumber]
      )
    );

    // Emit relevant events
    if (internalStatus === "picked_up") {
      await emitEvent("LOGISTICS_PICKUP_CONFIRMED" as never, {
        trackingNumber: webhook.trackingNumber,
        carrier: webhook.carrier,
        timestamp: webhook.timestamp,
      } as never);
    }

    if (internalStatus === "customs_hold") {
      await notifier.notify({
        level: "warn",
        event: "LOGISTICS_CUSTOMS_HOLD",
        message: `海关滞留: ${webhook.trackingNumber} (${webhook.carrier}) — ${webhook.statusDescription}`,
        correlationId: webhook.trackingNumber,
        metadata: { trackingNumber: webhook.trackingNumber, carrier: webhook.carrier },
      });
    }

    if (internalStatus === "delivered") {
      await emitEvent("LOGISTICS_DELIVERED" as never, {
        trackingNumber: webhook.trackingNumber,
        carrier: webhook.carrier,
        timestamp: webhook.timestamp,
      } as never);
    }
  }

  // ==============================================================
  // Delay Monitoring
  // ==============================================================

  /**
   * Check for logistics delays and send Telegram alerts.
   * Criteria:
   *   - Paid > 48h with no tracking → "no pickup" alert
   *   - Shipped but in customs > 72h → "customs delay" alert
   */
  async checkDelays(): Promise<number> {
    if (!this.db) return 0;

    let alertCount = 0;

    // 1. No pickup within 48h of payment
    const noPickup = await this.db.all<{
      posting_number: string; total_amount_cny: number; id: string;
      pay_time: string; logistics_carrier: string;
    }>(
      `SELECT ozon_posting_number AS posting_number, total_amount_cny, id, pay_time,
              COALESCE(logistics_carrier, '') AS logistics_carrier
       FROM purchase_1688
       WHERE payment_status = 'paid'
       AND (logistics_status = 'idle' OR logistics_status IS NULL)
       AND pay_time IS NOT NULL
       AND datetime(pay_time) < datetime('now', '-48 hours')
       LIMIT 50`
    );

    for (const row of noPickup) {
      const hoursSincePayment = Math.round(
        (Date.now() - new Date(row.pay_time).getTime()) / 3600000
      );

      await notifier.notify({
        level: "critical",
        event: "LOGISTICS_NO_PICKUP",
        message: `⚠️ 超${hoursSincePayment}小时未揽收: ${row.posting_number} (${row.total_amount_cny} CNY)`,
        correlationId: row.posting_number,
        force: true,
        metadata: {
          postingNumber: row.posting_number,
          hours: String(hoursSincePayment),
          amountCny: String(row.total_amount_cny),
          purchaseId: row.id,
        },
      });

      await emitEvent("LOGISTICS_DELAY" as never, {
        postingNumber: row.posting_number,
        hours: String(hoursSincePayment),
        amountCny: String(row.total_amount_cny),
      } as never);

      alertCount++;
    }

    // 2. Customs hold > 72h
    const customsHold = await this.db.all<{
      posting_number: string; total_amount_cny: number; id: string;
      logistics_tracking: string; logistics_carrier: string;
    }>(
      `SELECT ozon_posting_number AS posting_number, total_amount_cny, id,
              logistics_tracking, COALESCE(logistics_carrier, '') AS logistics_carrier
       FROM purchase_1688
       WHERE logistics_status = 'customs_hold'
       AND logistics_updated_at IS NOT NULL
       AND datetime(logistics_updated_at) < datetime('now', '-72 hours')
       LIMIT 50`
    );

    for (const row of customsHold) {
      await notifier.notify({
        level: "critical",
        event: "LOGISTICS_CUSTOMS_DELAY",
        message: `🚨 清关滞留超72h: ${row.posting_number} (${row.logistics_tracking} / ${row.logistics_carrier})`,
        correlationId: row.posting_number,
        force: true,
        metadata: {
          postingNumber: row.posting_number,
          trackingNumber: row.logistics_tracking,
          carrier: row.logistics_carrier,
          amountCny: String(row.total_amount_cny),
        },
      });

      alertCount++;
    }

    if (alertCount > 0) {
      logger.warn({ alertCount }, "LogisticsOrchestrator: delay alerts sent");
    }

    return alertCount;
  }

  // ==============================================================
  // Cost Writeback to Finance
  // ==============================================================

  /**
   * Write logistics costs back to local_orders for profit calculation.
   * Called after shipment creation and upon delivery.
   */
  async writeLogisticsCost(postingNumber: string): Promise<void> {
    if (!this.db) return;

    const purchase = await this.db.all<{
      logistics_cost_rub: number; logistics_carrier: string;
      ozon_posting_number: string; total_amount_cny: number;
    }>(
      `SELECT logistics_cost_rub, logistics_carrier, ozon_posting_number, total_amount_cny
       FROM purchase_1688
       WHERE ozon_posting_number = ?`,
      [postingNumber]
    );

    if (purchase.length === 0) return;
    const p = purchase[0]!;

    // Update local_orders with logistics cost
    await this.db.run(
      `UPDATE local_orders
       SET shipping_cost_rub = ?,
           shipping_carrier = ?,
           updated_at = datetime('now')
       WHERE posting_number = ?`,
      [p.logistics_cost_rub || 0, p.logistics_carrier, postingNumber]
    ).catch(() => {});

    // Recalculate profit: total_price_rub - total_cost_cny * exchange_rate - shipping_cost_rub
    try {
      const { getExchangeRate } = await import("./exchange-rate.js");
      const rateResult = await getExchangeRate();
      const rate: number = rateResult.rate;
      const costRub: number = (Number(p.total_amount_cny) || 0) * rate;
      const shippingRub: number = Number(p.logistics_cost_rub) || 0;

      await this.db.run(
        `UPDATE ozon_orders
         SET total_profit_rub = total_price_rub - ? - ?,
             total_cost_cny = total_cost_cny + ?,
             updated_at = datetime('now')
         WHERE posting_number = ?`,
        [Math.round(costRub), shippingRub, Math.round(shippingRub / rate), postingNumber]
      ).catch(() => {});
    } catch {
      // Exchange rate unavailable — skip profit recalc
    }

    logger.info({ postingNumber, logisticsCostRub: p.logistics_cost_rub }, "LogisticsOrchestrator: cost writeback complete");
  }

  // ==============================================================
  // Diagnose
  // ==============================================================

  /**
   * Comprehensive logistics diagnostic — all orders, tracking status, carrier stats.
   */
  async diagnose(): Promise<DiagnoseResult> {
    const empty: DiagnoseResult = {
      totalShipments: 0,
      byCarrier: {},
      byStatus: {},
      delayedCount: 0,
      delayedOrders: [],
      averageCostByCarrier: {},
      recentTrackingUpdates: [],
    };

    if (!this.db) return empty;

    // Total shipments + by carrier
    const byCarrier = await this.db.all<{ carrier: string; cnt: number }>(
      `SELECT COALESCE(logistics_carrier, 'unknown') AS carrier, COUNT(*) AS cnt
       FROM purchase_1688
       WHERE logistics_tracking IS NOT NULL AND logistics_tracking != ''
       GROUP BY logistics_carrier`
    );

    const byCarrierMap: Record<string, number> = {};
    let totalShipments = 0;
    for (const row of byCarrier) {
      byCarrierMap[row.carrier] = row.cnt;
      totalShipments += row.cnt;
    }

    // By status
    const byStatus = await this.db.all<{ status: string; cnt: number }>(
      `SELECT COALESCE(logistics_status, 'idle') AS status, COUNT(*) AS cnt
       FROM purchase_1688
       WHERE payment_status = 'paid'
       GROUP BY logistics_status`
    );

    const byStatusMap: Record<string, number> = {};
    for (const row of byStatus) {
      byStatusMap[row.status] = row.cnt;
    }

    // Delayed orders
    const delayedRows = await this.db.all<{
      posting_number: string; pay_time: string; logistics_carrier: string;
    }>(
      `SELECT ozon_posting_number AS posting_number, pay_time,
              COALESCE(logistics_carrier, '') AS logistics_carrier
       FROM purchase_1688
       WHERE payment_status = 'paid'
       AND (logistics_status = 'idle' OR logistics_status IS NULL)
       AND pay_time IS NOT NULL
       AND datetime(pay_time) < datetime('now', '-48 hours')
       LIMIT 100`
    );

    const delayedOrders = delayedRows.map((r) => ({
      postingNumber: r.posting_number,
      hoursSincePayment: Math.round((Date.now() - new Date(r.pay_time).getTime()) / 3600000),
      carrier: r.logistics_carrier,
    }));

    // Average cost by carrier
    const avgCostRows = await this.db.all<{ carrier: string; avg_cost: number }>(
      `SELECT COALESCE(logistics_carrier, 'unknown') AS carrier,
              AVG(COALESCE(logistics_cost_rub, 0)) AS avg_cost
       FROM purchase_1688
       WHERE logistics_cost_rub > 0
       GROUP BY logistics_carrier`
    );

    const avgCostByCarrier: Record<string, number> = {};
    for (const row of avgCostRows) {
      avgCostByCarrier[row.carrier] = Math.round(row.avg_cost);
    }

    // Recent tracking updates
    const recentTracking = await this.db.all<{
      posting_number: string; tracking_number: string; status: string; updated_at: string;
    }>(
      `SELECT ozon_posting_number AS posting_number,
              COALESCE(logistics_tracking, '') AS tracking_number,
              COALESCE(logistics_status, 'idle') AS status,
              updated_at
       FROM purchase_1688
       WHERE logistics_tracking IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 20`
    );

    const recentTrackingUpdates = recentTracking.map((r) => ({
      postingNumber: r.posting_number,
      trackingNumber: r.tracking_number,
      status: r.status,
      updated: r.updated_at,
    }));

    return {
      totalShipments,
      byCarrier: byCarrierMap,
      byStatus: byStatusMap,
      delayedCount: delayedOrders.length,
      delayedOrders,
      averageCostByCarrier: avgCostByCarrier,
      recentTrackingUpdates,
    };
  }

  // ==============================================================
  // Helpers
  // ==============================================================

  /**
   * Map carrier-specific status strings to internal canonical statuses.
   */
  private mapCarrierStatus(carrierStatus: string, _carrier: string): string {
    const s = carrierStatus.toLowerCase();

    if (s.includes("created") || s.includes("принят") || s.includes("accepted")) return "accepted";
    if (s.includes("pickup") || s.includes("забран") || s.includes("взят")) return "picked_up";
    if (s.includes("transit") || s.includes("в пути") || s.includes("перевозка")) return "in_transit";
    if (s.includes("customs") || s.includes("таможн") || s.includes("custom")) return "customs_hold";
    if (s.includes("delivered") || s.includes("доставлен") || s.includes("вручен")) return "delivered";
    if (s.includes("return") || s.includes("возврат")) return "returned";
    if (s.includes("cancel") || s.includes("отмен")) return "cancelled";

    return "in_transit"; // default
  }
}
