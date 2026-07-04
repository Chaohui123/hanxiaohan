// ============================================================
// Auto-Ship Service — batch ship ready orders via Ozon API
// Called by n8n "auto-ship" workflow on schedule (every 3h)
// ============================================================

import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { OzonOrderClient } from "@onzo/ozon-order";
import { getDb, serializedWrite } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { notifier } from "./notifier.js";

export interface ShipResult {
  postingNumber: string;
  status: "shipped" | "skipped" | "failed";
  trackingNumber?: string;
  error?: string;
}

export interface BatchShipResult {
  total: number;
  shipped: number;
  skipped: number;
  failed: number;
  results: ShipResult[];
}

/**
 * Generate a tracking number placeholder.
 * In production, replace with logistics provider API call (CDEK, Почта России, etc.).
 */
function generateTrackingNumber(postingNumber: string): string {
  const ts = Date.now().toString(36).toUpperCase();
  return `ONZO-${ts}-${postingNumber.slice(-6)}`;
}

/**
 * Ship all orders currently in "awaiting_deliver" status.
 * Each order ships independently — one failure doesn't block others.
 */
export async function batchShipOrders(ozonClient: OzonClient): Promise<BatchShipResult> {
  const db = await getDb();
  if (!db) {
    logger.error("Auto-ship: DB unavailable");
    return { total: 0, shipped: 0, skipped: 0, failed: 0, results: [] };
  }

  // Find orders ready to ship
  const pendingOrders = await db.all<{
    posting_number: string;
    store_id: string;
    raw_json: string;
  }>(
    "SELECT posting_number, store_id, raw_json FROM local_orders WHERE status = 'awaiting_deliver' ORDER BY created_at ASC LIMIT 50"
  );

  if (pendingOrders.length === 0) {
    logger.info("Auto-ship: No pending orders to ship");
    return { total: 0, shipped: 0, skipped: 0, failed: 0, results: [] };
  }

  logger.info({ count: pendingOrders.length }, "Auto-ship: Processing orders");
  const client = new OzonOrderClient(ozonClient);
  const results: ShipResult[] = [];
  let shipped = 0, skipped = 0, failed = 0;

  for (const order of pendingOrders) {
    try {
      // Parse products from raw_json stored at sync time
      let products: Array<{ sku: number; quantity: number }> = [];
      try {
        const raw = JSON.parse(order.raw_json || "{}");
        products = (raw.products || raw.items || []).map((p: { sku?: number; product_id?: number; quantity: number }) => ({
          sku: p.sku ?? p.product_id ?? 0,
          quantity: p.quantity ?? 1,
        }));
      } catch {
        // Can't ship without product info
        results.push({
          postingNumber: order.posting_number,
          status: "skipped",
          error: "Cannot parse product list from raw_json",
        });
        skipped++;
        continue;
      }

      if (products.length === 0) {
        results.push({
          postingNumber: order.posting_number,
          status: "skipped",
          error: "No products in order",
        });
        skipped++;
        continue;
      }

      // Generate tracking number (placeholder — replace with logistics API in production)
      const trackingNumber = generateTrackingNumber(order.posting_number);

      // Call Ozon ship API
      await client.shipOrder(order.posting_number, trackingNumber, products);

      // Update local order status
      await serializedWrite(() =>
        db.run(
          "UPDATE local_orders SET status = 'delivering', tracking_number = ?, updated_at = datetime('now') WHERE posting_number = ?",
          [trackingNumber, order.posting_number]
        )
      );

      results.push({ postingNumber: order.posting_number, status: "shipped", trackingNumber });
      shipped++;
      logger.info({ postingNumber: order.posting_number, trackingNumber }, "Auto-ship: Order shipped");
    } catch (err) {
      const msg = (err as Error).message;
      results.push({ postingNumber: order.posting_number, status: "failed", error: msg });
      failed++;
      logger.error({ postingNumber: order.posting_number, err: msg }, "Auto-ship: Shipment failed");
    }
  }

  const result: BatchShipResult = {
    total: pendingOrders.length,
    shipped,
    skipped,
    failed,
    results,
  };

  logger.info({ shipped, skipped, failed }, "Auto-ship: Batch complete");

  // Notify on failures
  if (failed > 0) {
    await notifier.notify({
      level: "warn",
      event: "批量发货",
      message: `${shipped}/${pendingOrders.length} 发货成功，${failed} 失败`,
      correlationId: `auto-ship-${Date.now()}`,
      metadata: { shipped: String(shipped), failed: String(failed), skipped: String(skipped) },
    }).catch(() => {});
  }

  return result;
}
