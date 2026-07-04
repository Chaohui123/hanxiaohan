// ============================================================
// Order Processor — new order handling, inventory, notifications
// Called by webhook.route.ts and sync flow
// ============================================================

import type { OzonPosting, LocalOrder } from "@onzo/shared-types";
import { getDb, serializedWrite } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { notifier } from "./notifier.js";

export interface OrderProcessResult {
  postingNumber: string;
  action: "created" | "updated" | "cancelled" | "skipped";
  success: boolean;
  error?: string;
}

/**
 * Process a NEW order: parse products, deduct inventory, notify.
 */
export async function processNewOrder(
  order: OzonPosting,
  storeId: string
): Promise<OrderProcessResult> {
  const db = await getDb().catch(() => null);
  if (!db) return { postingNumber: order.postingNumber, action: "created", success: false, error: "DB unavailable" };

  try {
    // 1. Insert local order record
    const local: LocalOrder = {
      id: order.postingNumber,
      postingNumber: order.postingNumber,
      orderId: order.orderId,
      status: order.status,
      createdAt: order.createdAt,
      updatedAt: new Date().toISOString(),
      buyerNameMasked: order.buyerName || "***",
      buyerPhoneMasked: order.buyerPhone || "***",
      totalPriceRub: order.price,
      commissionRub: order.commission,
      payoutRub: order.payout,
      productCount: order.products.length,
      trackingNumber: order.trackingNumber,
      rawJson: JSON.stringify(order),
    };

    await db.run(
      `INSERT OR REPLACE INTO local_orders
       (id, store_id, posting_number, order_id, status, created_at, updated_at,
        buyer_name_masked, buyer_phone_masked, total_price_rub, commission_rub, payout_rub,
        product_count, tracking_number, raw_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [local.id, storeId, local.postingNumber, local.orderId, local.status,
       local.createdAt, local.updatedAt, local.buyerNameMasked,
       local.buyerPhoneMasked, local.totalPriceRub, local.commissionRub,
       local.payoutRub, local.productCount, local.trackingNumber ?? null, local.rawJson]
    );

    // 2. Deduct inventory for each product in the order
    const { InventoryManager } = await import("@onzo/ozon-order/inventory");
    const inventoryMgr = new InventoryManager(db);
    for (const product of order.products) {
      if (product.sku && product.offerId) {
        const deductResult = await inventoryMgr.deduct(order.postingNumber, [
          { offerId: product.offerId, sku: product.sku, quantity: product.quantity },
        ]);
        if (!deductResult.success) {
          logger.warn({ postingNumber: order.postingNumber, sku: product.sku, reason: deductResult.reason },
            "Inventory deduction failed — continuing without blocking order");
        }
      }
    }

    // 3. Notify
    await notifier.notify({
      level: "info",
      event: "新订单",
      message: `订单 ${order.postingNumber}: ${order.products.length} 件商品, ${order.price} RUB`,
      correlationId: `order-${order.postingNumber}`,
      metadata: {
        postingNumber: order.postingNumber,
        products: String(order.products.length),
        price: String(order.price),
      },
    }).catch(() => {});

    logger.info({ postingNumber: order.postingNumber, products: order.products.length, price: order.price },
      "New order processed");

    return { postingNumber: order.postingNumber, action: "created", success: true };

  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ postingNumber: order.postingNumber, err: msg }, "Failed to process new order");
    return { postingNumber: order.postingNumber, action: "created", success: false, error: msg };
  }
}

/**
 * Handle order CANCELLATION: update status, restore inventory, notify.
 */
export async function processCancelledOrder(
  postingNumber: string,
  storeId: string
): Promise<OrderProcessResult> {
  const db = await getDb().catch(() => null);
  if (!db) return { postingNumber, action: "cancelled", success: false, error: "DB unavailable" };

  try {
    // 1. Update local status
    await db.run(
      "UPDATE local_orders SET status = 'cancelled', updated_at = datetime('now') WHERE posting_number = ?",
      [postingNumber]
    );

    // 2. Restore inventory
    await serializedWrite(async () => {
      const { InventoryManager } = await import("@onzo/ozon-order/inventory");
      const mgr = new InventoryManager(db!);
      const movements = await db!.all(
        "SELECT offer_id, sku, -quantity as qty FROM stock_movements WHERE posting_number = ? AND type = 'deduct'",
        [postingNumber]
      ) as Array<{ offer_id: string; sku: number; qty: number }>;

      if (movements.length > 0) {
        await mgr.restore(postingNumber, movements.map((m) => ({
          offerId: m.offer_id, sku: m.sku, quantity: Math.abs(m.qty),
        })));
      }
    });

    // 3. Notify
    await notifier.notify({
      level: "warn",
      event: "订单取消",
      message: `订单 ${postingNumber} 已取消，库存已恢复`,
      correlationId: `order-${postingNumber}`,
      metadata: { postingNumber },
    }).catch(() => {});

    logger.info({ postingNumber }, "Order cancelled — inventory restored");
    return { postingNumber, action: "cancelled", success: true };

  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ postingNumber, err: msg }, "Failed to process cancellation");
    return { postingNumber, action: "cancelled", success: false, error: msg };
  }
}

/**
 * Handle order STATUS CHANGE: update local status only.
 */
export async function processStatusChange(
  postingNumber: string,
  newStatus: string
): Promise<OrderProcessResult> {
  const db = await getDb().catch(() => null);
  if (!db) return { postingNumber, action: "updated", success: false, error: "DB unavailable" };

  try {
    await db.run(
      "UPDATE local_orders SET status = ?, updated_at = datetime('now') WHERE posting_number = ?",
      [newStatus, postingNumber]
    );

    logger.info({ postingNumber, status: newStatus }, "Order status updated");
    return { postingNumber, action: "updated", success: true };

  } catch (err) {
    return { postingNumber, action: "updated", success: false, error: (err as Error).message };
  }
}

// ---- Webhook Processing Metrics ----

interface WebhookMetrics {
  totalReceived: number;
  totalProcessed: number;
  totalFailed: number;
  avgProcessingMs: number;
  lastReceivedAt: string | null;
}

let webhookMetrics: WebhookMetrics = {
  totalReceived: 0,
  totalProcessed: 0,
  totalFailed: 0,
  avgProcessingMs: 0,
  lastReceivedAt: null,
};

export function getWebhookMetrics(): Readonly<WebhookMetrics> {
  return { ...webhookMetrics };
}

export function recordWebhookReceived(): void {
  webhookMetrics.totalReceived++;
  webhookMetrics.lastReceivedAt = new Date().toISOString();
}

export function recordWebhookProcessed(durationMs: number, success: boolean): void {
  if (success) {
    webhookMetrics.totalProcessed++;
  } else {
    webhookMetrics.totalFailed++;
  }
  webhookMetrics.avgProcessingMs = Math.round(
    (webhookMetrics.avgProcessingMs * (webhookMetrics.totalProcessed + webhookMetrics.totalFailed - 1) + durationMs) /
    (webhookMetrics.totalProcessed + webhookMetrics.totalFailed)
  );
}
