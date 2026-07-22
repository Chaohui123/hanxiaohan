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
      });

      // New orders additionally trigger inventory deduction
      if (payload.eventType === "order.created") {
        const order = {
          postingNumber: payload.postingNumber,
          orderId: payload.orderId,
          status: payload.status,
          createdAt: payload.timestamp,
          products: [] as Array<{ sku: number; quantity: number; price: number }>,
          price: 0,
          commission: 0,
          payout: 0,
        } as unknown as Parameters<typeof processNewOrder>[0];
        await processNewOrder(order, "store_1");
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
