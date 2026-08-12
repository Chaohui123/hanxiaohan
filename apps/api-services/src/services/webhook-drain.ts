// ============================================================
// Ozon Webhook Drain — async consumer for ozon_webhook_log.
// The HTTP receiver only persists raw requests and acks 200;
// ALL business logic (order processing, inventory deduction)
// runs here, out of the request path.
// ============================================================

import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { handleWebhookEvent, type WebhookPayload } from "@onzo/ozon-order/webhook";
import { processNewOrder, processCancelledOrder, processStatusChange } from "./order-processor.js";
import { writeToDeadLetter } from "./dead-letter.js";
import { nowDb } from "../utils/time.js";
import { emitEvent } from "./notification-events.js";
import { getActiveStoreConfigs } from "../db/models.js";
import { decrypt, isEncrypted } from "./crypto.js";

/**
 * Build an OzonOrderClient for the first active store (current setup is
 * single-store). Returns null when no store is configured.
 */
async function buildOrderClient() {
  const stores = await getActiveStoreConfigs();
  const store = stores[0];
  if (!store) return null;
  const apiKey = isEncrypted(store.apiKey) ? decrypt(store.apiKey) : store.apiKey;
  const { AuthManager, OzonClient } = await import("@onzo/ozon-api-wrapper");
  const auth = new AuthManager({ clients: [{ clientId: store.clientId, apiKey, storeId: store.storeId }] });
  const { OzonOrderClient } = await import("@onzo/ozon-order");
  return { orderClient: new OzonOrderClient(new OzonClient({ auth })), storeId: store.storeId };
}

interface WebhookLogRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  event_type: string;
  posting_number: string | null;
  order_id: number | null;
  status: string | null;
  payload_json: string;
  received_at: string;
}

/**
 * Process up to `limit` queued webhook events from ozon_webhook_log.
 * Each row transitions queued → processing → done|failed with an
 * optimistic status lock so concurrent drains never double-consume.
 * Failed rows keep their error and can be re-queued via the replay endpoint.
 */
export async function drainOzonWebhookLog(limit = 10): Promise<{ processed: number; failed: number }> {
  const db = await getDb().catch(() => null);
  if (!db) return { processed: 0, failed: 0 };

  const rows = (await db.all(
    "SELECT * FROM ozon_webhook_log WHERE process_status = 'queued' ORDER BY received_at ASC LIMIT ?",
    [limit]
  )) as WebhookLogRow[];

  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    // Optimistic lock: only one drain run can claim the row
    const lock = await db.run(
      "UPDATE ozon_webhook_log SET process_status = 'processing' WHERE id = ? AND process_status = 'queued'",
      [row.id]
    );
    if (lock.changes === 0) continue;

    const payload: WebhookPayload = {
      eventId: row.event_id,
      eventType: row.event_type as WebhookPayload["eventType"],
      postingNumber: row.posting_number ?? "",
      orderId: row.order_id ?? 0,
      status: (row.status ?? "awaiting_deliver") as WebhookPayload["status"],
      timestamp: row.received_at,
      rawBody: row.payload_json,
    };

    try {
      await handleWebhookEvent(payload, {
        onStatusChanged: async (p) => { await processStatusChange(p.postingNumber, p.status); },
        onDelivered: async (p) => { await processStatusChange(p.postingNumber, "delivered"); },
        onCancelled: async (p) => { await processCancelledOrder(p.postingNumber, "store_1"); },
        onMessage: async (p) => {
          let chatType = "";
          try { chatType = String(JSON.parse(p.rawBody).chat_type ?? ""); } catch { /* rawBody not JSON */ }
          await emitEvent("BUYER_MESSAGE", { chatType }, p.eventId);
        },
      });

      // New orders: fetch the real posting(s) so inventory deduction and the
      // notification carry actual data. Webhook pushes reference the order by
      // order_number (e.g. "0148010868-0049") while Ozon postings carry a
      // package suffix ("...-1") — fetch by order_number and merge packages.
      // Falls back to a minimal payload on API failure; notification still fires.
      if (payload.eventType === "order.created") {
        let order: Parameters<typeof processNewOrder>[0] | null = null;
        let storeId = "store_1";
        try {
          const built = await buildOrderClient();
          if (built) {
            storeId = built.storeId;
            const postings = await built.orderClient.listPostings({ orderNumber: payload.postingNumber });
            if (postings.length > 0) {
              order = {
                ...postings[0],
                // Keep order_number as the local key — every later webhook
                // event (status change / cancel) references the order by it.
                postingNumber: payload.postingNumber,
                status: postings[0].status,
                products: postings.flatMap((p) => p.products),
                price: postings.reduce((sum, p) => sum + p.price, 0),
              } as Parameters<typeof processNewOrder>[0];
            }
          }
        } catch (err) {
          logger.warn({ postingNumber: payload.postingNumber, err: (err as Error).message },
            "Posting fetch failed for new order — using minimal payload");
        }
        if (!order) {
          order = {
            postingNumber: payload.postingNumber,
            orderId: payload.orderId,
            status: "awaiting_packaging",
            createdAt: payload.timestamp,
            products: [] as Array<{ sku: number; quantity: number; price: number }>,
            price: 0,
            commission: 0,
            payout: 0,
          } as unknown as Parameters<typeof processNewOrder>[0];
        }
        await processNewOrder(order, storeId);
      }

      await db.run(
        "UPDATE ozon_webhook_log SET process_status = 'done', processed_at = ? WHERE id = ?",
        [nowDb(), row.id]
      );
      processed++;
    } catch (err) {
      const msg = (err as Error).message;
      await db.run(
        "UPDATE ozon_webhook_log SET process_status = 'failed', error = ?, processed_at = ? WHERE id = ?",
        [msg.slice(0, 500), nowDb(), row.id]
      ).catch(() => {});
      await writeToDeadLetter({
        taskType: "webhook_event",
        errorMessage: msg,
        payload: { logId: row.id, eventType: payload.eventType, postingNumber: payload.postingNumber },
        correlationId: row.id,
      }).catch(() => {});
      failed++;
      logger.error({ id: row.id, eventType: payload.eventType, postingNumber: payload.postingNumber, err: msg }, "Webhook event processing failed");
    }
  }

  if (processed + failed > 0) {
    logger.info({ processed, failed, total: rows.length }, "Webhook drain batch complete");
  }
  return { processed, failed };
}
