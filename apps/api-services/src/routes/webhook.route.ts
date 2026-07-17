// ============================================================
// Ozon Webhook receiver — POST /api/webhook/ozon
//
// Configuration:
//   1. Set PUBLIC_DOMAIN in .env (e.g. onzo.example.com)
//   2. The webhook URL Ozon will call:
//      https://{PUBLIC_DOMAIN}/api/webhook/ozon
//   3. Register via: npx tsx scripts/setup-webhook.ts
//   4. Ozon signs requests with HMAC-SHA256 using OZON_API_KEYS
//
// Ozon webhook source IPs (optional whitelist):
//   These are documented at https://docs.ozon.ru/api/seller/#section/Obshie-svedeniya
//   Add to OZON_WEBHOOK_IPS in .env (comma-separated) to enable validation.
// ============================================================

import { Router } from "express";
import { parseWebhookPayload, handleWebhookEvent, type WebhookPayload } from "@onzo/ozon-order/webhook";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { writeToDeadLetter } from "../services/dead-letter.js";
import { processNewOrder, processCancelledOrder, processStatusChange, recordWebhookReceived, recordWebhookProcessed } from "../services/order-processor.js";

// Ozon signs webhooks with HMAC-SHA256 using the API key.
// Some setups use a dedicated webhook secret (OZON_WEBHOOK_SECRET).
// Prefer the dedicated secret, fall back to the primary API key.
const API_SECRET = process.env.OZON_WEBHOOK_SECRET || process.env.OZON_API_KEYS || "";

// In production, reject webhooks without HMAC-SHA256 signature verification
const ENFORCE_WEBHOOK_SIGNATURE = (process.env.ENV || process.env.NODE_ENV) !== "dev";

// Optional: Ozon webhook IP whitelist (comma-separated CIDR or IPs)
const ALLOWED_WEBHOOK_IPS = (process.env.OZON_WEBHOOK_IPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isIpAllowed(clientIp: string): boolean {
  if (ALLOWED_WEBHOOK_IPS.length === 0) return true; // whitelist not configured

  // Simple prefix matching for CIDR-like or exact IPs
  return ALLOWED_WEBHOOK_IPS.some((allowed) => {
    if (allowed.includes("/")) {
      // Basic CIDR check: compare network prefix
      const [network, bits] = allowed.split("/");
      const prefix = parseInt(bits, 10);
      if (isNaN(prefix)) return clientIp === network;
      // Simple prefix byte comparison
      const clientParts = clientIp.split(".").map(Number);
      const netParts = network.split(".").map(Number);
      const matchBytes = Math.floor(prefix / 8);
      for (let i = 0; i < matchBytes; i++) {
        if (clientParts[i] !== netParts[i]) return false;
      }
      return true;
    }
    return clientIp === allowed;
  });
}

export function createWebhookRouter(): Router {
  const router = Router();

  // Webhook-specific body size guard — Ozon payloads are < 10KB, 100KB is generous
  router.post("/webhook/ozon", (req, res, next) => {
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);
    if (contentLength > 100_000) {
      res.status(413).json({
        success: false,
        error: { code: "PAYLOAD_TOO_LARGE", message: "Webhook body exceeds 100KB limit", retryable: false },
        correlationId: (req as unknown as { correlationId?: string }).correlationId ?? "unknown",
      });
      return;
    }
    next();
  });

  router.post("/webhook/ozon", async (req, res) => {
    const rawBodyBuffer = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const rawBody = rawBodyBuffer ? rawBodyBuffer.toString("utf8") : JSON.stringify(req.body);
    const signature = req.headers["x-ozon-signature"] as string | undefined;
    const clientIp = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "").split(",")[0].trim();

    // Log every incoming webhook event for audit
    logger.info({
      clientIp,
      hasSignature: !!signature,
      contentType: req.headers["content-type"],
      correlationId: req.correlationId,
    }, "Webhook request received");

    // Optional IP whitelist check
    if (!isIpAllowed(clientIp)) {
      logger.warn({ clientIp, correlationId: req.correlationId }, "Webhook rejected — IP not in whitelist");
      res.status(403).json({
        success: false,
        error: { code: "IP_NOT_ALLOWED", message: "Source IP not in OZON_WEBHOOK_IPS whitelist", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }

    // Reject requests without signature in production — prevents forged webhooks
    if (ENFORCE_WEBHOOK_SIGNATURE && !signature) {
      logger.warn({ clientIp, correlationId: req.correlationId }, "Webhook rejected — missing X-Ozon-Signature header");
      res.status(401).json({
        success: false,
        error: { code: "MISSING_SIGNATURE", message: "X-Ozon-Signature header required", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }

    const dedupStore = {
      /**
       * Atomic dedup: ON CONFLICT(event_id) DO NOTHING skips existing events.
       * Returns true if already processed (insert ignored = row existed).
       * This eliminates the race condition between SELECT + INSERT.
       */
      async isDuplicate(eventId: string): Promise<boolean> {
        const db = await getDb().catch(() => null);
        if (!db) return false;
        // Atomic dedup: ON CONFLICT DO NOTHING skips existing event_id
        const result = await db.run(
          "INSERT INTO webhook_events (event_id, posting_number, event_type, created_at) VALUES (?, NULL, NULL, NOW()) ON CONFLICT(event_id) DO NOTHING",
          [eventId]
        );
        // rowCount === 0 means the row already existed → duplicate (PG returns null for no insert)
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

    // Log event type for monitoring
    logger.info({
      eventType: payload.eventType,
      postingNumber: payload.postingNumber,
      orderId: payload.orderId,
      status: payload.status,
      correlationId: req.correlationId,
    }, "Webhook event processing");

    // Respond immediately (Ozon expects fast 200) — process async
    res.json({ success: true, eventId: payload.eventId, correlationId: req.correlationId });
    recordWebhookReceived();

    // Background processing
    const processStart = Date.now();
    try {
      await handleWebhookEvent(payload, {
        onStatusChanged: async (p) => {
          await processStatusChange(p.postingNumber, p.status);
        },
        onDelivered: async (p) => {
          await processStatusChange(p.postingNumber, "delivered");
        },
        onCancelled: async (p) => {
          await processCancelledOrder(p.postingNumber, "store_1");
        },
      });

      // If it's a new order, process inventory
      if (payload.eventType === "order.created") {
        // Reconstruct minimal OzonPosting for new order processing
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

      recordWebhookProcessed(Date.now() - processStart, true);
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.error({ correlationId: req.correlationId, err: errorMsg }, "Webhook event handling failed");
      recordWebhookProcessed(Date.now() - processStart, false);
      writeToDeadLetter({
        taskType: "webhook",
        errorMessage: errorMsg,
        payload: { eventId: payload.eventId },
        correlationId: req.correlationId,
      }).catch(() => {});

      // Enqueue a retry task — stuck-task-recovery will pick it up
      const db = await getDb().catch(() => null);
      if (db) {
        await db.run(
          `INSERT INTO task_queue (id, type, status, payload_json, store_id, priority, max_retries, created_at)
           VALUES (?, 'webhook_retry', 'queued', ?, 'store_1', 5, 3, NOW())`,
          [`wr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, JSON.stringify({ eventType: payload.eventType, body: JSON.parse(rawBody) })]
        ).catch(() => {});
      }
    }
  });

  return router;
}
