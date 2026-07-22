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
import { parseWebhookPayload, type WebhookPayload } from "@onzo/ozon-order/webhook";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { recordWebhookReceived, recordWebhookProcessed } from "../services/order-processor.js";

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

  // Strip deprecation headers that interfere with Ozon validation
  function stripDeprecationHeaders(res: import("express").Response) {
    res.removeHeader("X-API-Deprecated");
    res.removeHeader("X-API-Deprecation-Date");
    res.removeHeader("Sunset");
  }

  // HEAD/GET: Ozon URL verification test → always 200
  // Paths: "/webhook/ozon" (mounted at /api, /api/v1) and "/webhook" (mounted at /ozon → /ozon/webhook)
  router.use(["/webhook/ozon", "/webhook"], (req, res, next) => {
    stripDeprecationHeaders(res);
    if (req.method === "HEAD" || req.method === "GET") {
      res.status(200).end();
      return;
    }
    next();
  });

  // Webhook-specific body size guard — Ozon payloads are < 10KB, 100KB is generous
  router.post(["/webhook/ozon", "/webhook"], (req, res, next) => {
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

  router.post(["/webhook/ozon", "/webhook"], async (req, res) => {
    const rawBodyBuffer = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const rawBody = rawBodyBuffer ? rawBodyBuffer.toString("utf8") : JSON.stringify(req.body);
    const signature = req.headers["x-ozon-signature"] as string | undefined;
    const clientIp = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "").split(",")[0].trim();

    // Log full body for debugging Ozon registration
    logger.info({ body: rawBody.slice(0, 500) }, "Webhook raw body");

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

    // Parse request body
    const rawJson = rawBody.length > 0 ? (() => { try { return JSON.parse(rawBody); } catch { return null; } })() : null;

    // Ozon TYPE_PING (URL verification): response MUST match Ozon's template
    // {version, name, time} — anything else fails with WRONG_RESULT_FIELD.
    if (rawJson && (rawJson as Record<string,unknown>).message_type === "TYPE_PING") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      res.status(200).send(JSON.stringify({ version: "1.0.0", name: "onzo-api-services", time: now }));
      return;
    }

    // Empty body / no signature → Ozon template ack: result is the STRING "true"
    if (!rawJson || Object.keys(rawJson).length === 0 || !signature) {
      res.status(200).send('{"result":"true"}');
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
      // VerificationResult — duplicates must ack 200 so Ozon doesn't retry pointlessly
      const isDuplicate = (parsed.reason ?? "").startsWith("Duplicate event");
      res.status(isDuplicate ? 200 : 400).json({
        success: parsed.valid || isDuplicate,
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
    }, "Webhook event accepted");

    // ---- Event-driven architecture ----
    // 1. Persist the RAW request FIRST (audit trail, before any processing)
    // 2. Enqueue via the log row (process_status='queued') for the drain job
    // 3. Respond 200 immediately — ALL business logic runs asynchronously
    const logId = `owl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const db = await getDb().catch(() => null);
    if (db) {
      await db.run(
        `INSERT INTO ozon_webhook_log (id, event_id, event_type, posting_number, order_id, status, signature, client_ip, payload_json, process_status, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NOW())
         ON CONFLICT(event_id) DO NOTHING`,
        [logId, payload.eventId, payload.eventType, payload.postingNumber, payload.orderId, payload.status, signature ?? null, clientIp, rawBody]
      ).catch((err: Error) => logger.warn({ err: err.message }, "ozon_webhook_log insert failed — continuing ack"));
    } else {
      logger.error({ correlationId: req.correlationId }, "DB unavailable — webhook event will not be persisted/queued");
    }

    // Ozon ack template — result is the STRING "true" (verified against
    // muscobytes/laravel-ozon-seller-webhook and Ozon push docs)
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send('{"result":"true"}');
    recordWebhookReceived();
    recordWebhookProcessed(0, true);
  });

  // Manual replay — re-queue a FAILED webhook event for the drain job.
  // Requires API key (not in PUBLIC_PATHS) by design.
  router.post(["/webhook/replay/:id", "/replay/:id"], async (req, res) => {
    const db = await getDb().catch(() => null);
    if (!db) {
      res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE", message: "Database unavailable", retryable: true }, correlationId: req.correlationId });
      return;
    }
    const result = await db.run(
      "UPDATE ozon_webhook_log SET process_status = 'queued', error = NULL, processed_at = NULL WHERE id = ? AND process_status = 'failed'",
      [req.params.id]
    );
    if (result.changes === 0) {
      res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND_OR_NOT_FAILED", message: "No failed webhook event with this id", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }
    logger.info({ id: req.params.id }, "Webhook event re-queued for replay");
    res.json({ success: true, data: { id: req.params.id, processStatus: "queued" }, correlationId: req.correlationId });
  });

  return router;
}
