// ============================================================
// Ozon Webhook receiver — POST /api/webhook/ozon
// ============================================================

import { Router } from "express";
import { parseWebhookPayload, handleWebhookEvent, type WebhookPayload } from "@onzo/ozon-order/webhook";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { writeToDeadLetter } from "../services/dead-letter.js";

const API_SECRET = process.env.OZON_API_KEYS || "";

// In production, reject webhooks without HMAC-SHA256 signature verification
const ENFORCE_WEBHOOK_SIGNATURE = (process.env.ENV || process.env.NODE_ENV) !== "dev";

export function createWebhookRouter(): Router {
  const router = Router();

  router.post("/webhook/ozon", async (req, res) => {
    const rawBodyBuffer = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const rawBody = rawBodyBuffer ? rawBodyBuffer.toString("utf8") : JSON.stringify(req.body);
    const signature = req.headers["x-ozon-signature"] as string | undefined;

    // Reject requests without signature in production — prevents forged webhooks
    if (ENFORCE_WEBHOOK_SIGNATURE && !signature) {
      logger.warn({ correlationId: req.correlationId }, "Webhook rejected — missing X-Ozon-Signature header");
      res.status(401).json({
        success: false,
        error: { code: "MISSING_SIGNATURE", message: "X-Ozon-Signature header required", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }

    const dedupStore = {
      /**
       * Atomic dedup: INSERT OR IGNORE checks UNIQUE constraint on event_id.
       * Returns true if already processed (insert ignored = row existed).
       * This eliminates the race condition between SELECT + INSERT.
       */
      async isDuplicate(eventId: string): Promise<boolean> {
        const db = await getDb().catch(() => null);
        if (!db) return false;
        // Try to insert — if it already exists, INSERT OR IGNORE does nothing
        const result = await db.run(
          "INSERT OR IGNORE INTO webhook_events (event_id, posting_number, event_type, created_at) VALUES (?, NULL, NULL, datetime('now'))",
          [eventId]
        );
        // changes === 0 means the row already existed → duplicate
        return result.changes === 0;
      },
      async markProcessed(eventId: string, meta?: { postingNumber?: string; eventType?: string }): Promise<void> {
        const db = await getDb().catch(() => null);
        if (!db) return;
        // Update metadata for an already-inserted event (from isDuplicate above)
        await db.run(
          "UPDATE webhook_events SET posting_number = ?, event_type = ? WHERE event_id = ?",
          [meta?.postingNumber ?? null, meta?.eventType ?? null, eventId]
        );
      },
    };

    // Parse + verify + dedup
    const parsed = await parseWebhookPayload(rawBody, signature, API_SECRET, { dedupStore });

    if (!("eventId" in parsed)) {
      // VerificationResult
      res.status(parsed.reason === "Duplicate event" ? 200 : 400).json({
        success: parsed.valid,
        reason: parsed.reason,
        correlationId: req.correlationId,
      });
      return;
    }

    const payload: WebhookPayload = parsed;

    // Handle the event — update local order status
    try {
    await handleWebhookEvent(payload, {
      onStatusChanged: async (p) => {
        const db = await getDb().catch(() => null);
        if (!db) return;

        await db.run(
          "UPDATE local_orders SET status = ?, updated_at = datetime('now') WHERE posting_number = ?",
          [p.status, p.postingNumber]
        );
        logger.info({ postingNumber: p.postingNumber, status: p.status }, "Webhook order status update");
      },

      onDelivered: async (p) => {
        const db = await getDb().catch(() => null);
        if (!db) return;

        await db.run(
          "UPDATE local_orders SET status = 'delivered', updated_at = datetime('now') WHERE posting_number = ?",
          [p.postingNumber]
        );

        // Confirm inventory delivery
        const { serializedWrite } = await import("../db/connection.js");
        await serializedWrite(async () => {
          const inv = await import("@onzo/ozon-order/inventory");
          const mgr = new inv.InventoryManager(db!);
          await mgr.confirmDelivery(p.postingNumber);
        });

        logger.info({ postingNumber: p.postingNumber }, "Webhook order delivered — inventory updated");
      },

      onCancelled: async (p) => {
        const db = await getDb().catch(() => null);
        if (!db) return;

        await db.run(
          "UPDATE local_orders SET status = 'cancelled', updated_at = datetime('now') WHERE posting_number = ?",
          [p.postingNumber]
        );

        // Restore inventory
        const { serializedWrite } = await import("../db/connection.js");
        await serializedWrite(async () => {
          const inv = await import("@onzo/ozon-order/inventory");
          const mgr = new inv.InventoryManager(db!);
          const m = await db!.all(
            "SELECT offer_id, sku, -quantity as qty FROM stock_movements WHERE posting_number = ? AND type = 'deduct'",
            [p.postingNumber]
          ) as Array<{ offer_id: string; sku: number; qty: number }>;
          if (m.length > 0) {
            await mgr.restore(p.postingNumber, m.map(x => ({ offerId: x.offer_id, sku: x.sku, quantity: x.qty })));
          }
        });

        logger.info({ postingNumber: p.postingNumber }, "Webhook order cancelled — inventory restored");
      },
    });

    res.json({ success: true, eventId: payload.eventId, correlationId: req.correlationId });
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.error({ correlationId: req.correlationId, err: errorMsg }, "Webhook event handling failed");
      writeToDeadLetter({
        taskType: "webhook",
        errorMessage: errorMsg,
        payload: { eventId: (parsed as { eventId?: string }).eventId ?? "unknown" },
        correlationId: req.correlationId,
      }).catch(() => {});
      res.status(500).json({ success: false, error: { code: "WEBHOOK_FAILED", message: errorMsg, retryable: true }, correlationId: req.correlationId });
    }
  });

  return router;
}
