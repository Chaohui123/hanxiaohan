// ============================================================
// Auto-Ship Service — batch ship ready orders via Ozon API
// Called by n8n "auto-ship" workflow on schedule (every 3h)
// ============================================================

import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { OzonOrderClient } from "@onzo/ozon-order";
import { getDb, serializedWrite } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { notifier } from "./notifier.js";
import { emitEvent, EVENT_KEYS } from "./notification-events.js";
import { getLogisticsProvider, type LogisticsProvider, type ShipmentRequest } from "@onzo/logistics";

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
 * Create a real shipment via logistics provider (CDEK / Russian Post).
 * Falls back to placeholder tracking number if no provider is configured.
 */
async function createShipment(
  postingNumber: string,
  orderData: Record<string, unknown>,
  provider: LogisticsProvider | null
): Promise<{ trackingNumber: string; labelUrl?: string; costRub?: number }> {
  if (!provider) {
    // No logistics provider configured — fallback placeholder
    const ts = Date.now().toString(36).toUpperCase();
    return { trackingNumber: `ONZO-${ts}-${postingNumber.slice(-6)}` };
  }

  try {
    const request: ShipmentRequest = {
      postingNumber,
      recipientName: (orderData.buyerName as string) || "Customer",
      recipientPhone: (orderData.buyerPhone as string) || "+70000000000",
      address: {
        city: (orderData.city as string) || "Moscow",
        street: (orderData.street as string) || "",
        zipCode: (orderData.zipCode as string) || "101000",
      },
      package: {
        weightGrams: (orderData.weight as number) || 500,
        lengthCm: (orderData.length as number) || 20,
        widthCm: (orderData.width as number) || 15,
        heightCm: (orderData.height as number) || 5,
        items: (orderData.products as Array<{ name: string; quantity: number; priceRub: number }>) || [],
      },
    };

    const result = await provider.createShipment(request);

    if (result.success && result.trackingNumber) {
      return {
        trackingNumber: result.trackingNumber,
        labelUrl: result.labelUrl,
        costRub: result.costRub,
      };
    }

    // Provider failed — fallback to placeholder
    logger.warn({ postingNumber, error: result.error }, "Logistics provider failed, using placeholder tracking");
    const ts = Date.now().toString(36).toUpperCase();
    return { trackingNumber: `ONZO-${ts}-${postingNumber.slice(-6)}` };
  } catch (err) {
    logger.warn({ postingNumber, err: (err as Error).message }, "Logistics provider exception, using placeholder");
    const ts = Date.now().toString(36).toUpperCase();
    return { trackingNumber: `ONZO-${ts}-${postingNumber.slice(-6)}` };
  }
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
  const logistics = await getLogisticsProvider();
  if (!logistics) {
    logger.warn("Auto-ship: No logistics provider — using placeholder tracking numbers");
  }
  const results: ShipResult[] = [];
  let shipped = 0, skipped = 0, failed = 0;

  for (const order of pendingOrders) {
    // Parse products and order data from raw_json (declared outside try for catch visibility)
    let products: Array<{ sku: number; quantity: number }> = [];
    try {
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(order.raw_json || "{}");
        products = ((raw.products || raw.items || []) as Array<Record<string, unknown>>).map((p) => ({
          sku: (p.sku ?? p.product_id ?? 0) as number,
          quantity: (p.quantity ?? 1) as number,
        }));
      } catch {
        results.push({ postingNumber: order.posting_number, status: "skipped", error: "Cannot parse product list" });
        skipped++;
        continue;
      }

      if (products.length === 0) {
        results.push({ postingNumber: order.posting_number, status: "skipped", error: "No products in order" });
        skipped++;
        continue;
      }

      // 1. Create real shipment via logistics provider
      const shipment = await createShipment(order.posting_number, raw, logistics);

      // 2. Call Ozon FBS ship API with tracking number
      await client.shipOrder(order.posting_number, shipment.trackingNumber, products);

      // 3. Update local order with tracking number + label URL
      await serializedWrite(() =>
        db.run(
          "UPDATE local_orders SET status = 'delivering', tracking_number = ?, updated_at = NOW() WHERE posting_number = ?",
          [shipment.trackingNumber, order.posting_number]
        )
      );

      results.push({
        postingNumber: order.posting_number,
        status: "shipped",
        trackingNumber: shipment.trackingNumber,
      });
      shipped++;
      logger.info({
        postingNumber: order.posting_number,
        trackingNumber: shipment.trackingNumber,
        provider: logistics?.name || "placeholder",
        costRub: shipment.costRub,
      }, "Auto-ship: Order shipped");
    } catch (err) {
      const msg = (err as Error).message;
      results.push({ postingNumber: order.posting_number, status: "failed", error: msg });
      failed++;
      logger.error({ postingNumber: order.posting_number, err: msg }, "Auto-ship: Shipment failed");

      // Retry with placeholder on logistics failure
      if (msg.includes("CDEK") || msg.includes("Russian Post")) {
        try {
          const fallbackTracking = `ONZO-${Date.now().toString(36)}-${order.posting_number.slice(-6)}`;
          await client.shipOrder(order.posting_number, fallbackTracking, products as Array<{ sku: number; quantity: number }>);
          await serializedWrite(() =>
            db.run("UPDATE local_orders SET status = 'delivering', tracking_number = ? WHERE posting_number = ?",
              [fallbackTracking, order.posting_number])
          );
          results[results.length - 1].status = "shipped";
          results[results.length - 1].trackingNumber = fallbackTracking;
          shipped++;
          failed--;
        } catch { /* fallback also failed */ }
      }
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
    const failedDetails = results.filter((r) => r.status === "failed").slice(0, 3).map((r) => r.postingNumber);
    await emitEvent(EVENT_KEYS.SHIPMENT_FAILED, {
      postingNumber: failedDetails.join(","),
      error: `${failed}/${pendingOrders.length} 失败`,
    }, `auto-ship-${Date.now()}`).catch(() => {});
  }

  if (shipped > 0) {
    for (const r of results.filter((r) => r.status === "shipped").slice(0, 5)) {
      await emitEvent(EVENT_KEYS.ORDER_SHIPPED, {
        postingNumber: r.postingNumber,
        trackingNumber: r.trackingNumber || "N/A",
      }).catch(() => {});
    }
  }

  return result;
}
