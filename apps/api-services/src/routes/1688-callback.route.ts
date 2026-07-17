// ============================================================
// 1688 Message Callback Route — POST /api/1688/message/callback
// Receives 1688 push events: order, payment, logistics
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { emitEvent, EVENT_KEYS } from "../services/notification-events.js";
import {
  verifySignature,
  parseMessage,
  checkCallbackIp,
  isDuplicate,
  processCallbackMessage,
} from "../services/1688-callback.js";

export function create1688CallbackRouter(): Router {
  const router = Router();

  /**
   * POST /api/1688/message/callback
   * 1688生产消息通道推送接口
   *
   * Headers:
   *   X-1688-Signature: algorithm=HMAC-SHA256, sign=<hex>
   *   X-1688-Message-Id: <unique message id>
   *
   * Body: JSON with message_id, type, timestamp, data
   *
   * Response: always "success" (plain text) per 1688 callback spec
   */
  router.post("/1688/message/callback", async (req, res) => {
    const clientIp = (req.headers["x-forwarded-for"] as string) || req.ip || "unknown";
    const signatureHeader = (req.headers["x-1688-signature"] as string) || "";
    const rawBody = req.body instanceof Buffer ? req.body.toString("utf-8") : JSON.stringify(req.body);
    const isProduction = (process.env.ENV || process.env.NODE_ENV) === "production";

    // 0. IP whitelist check (production only)
    if (isProduction) {
      const ipCheck = checkCallbackIp(clientIp);
      if (!ipCheck.allowed) {
        logger.warn({ clientIp }, "1688 Callback: IP blocked");
        res.status(403).send("success"); // 1688 expects "success" even on errors
        return;
      }
    }

    // 1. Signature verification
    if (isProduction || process.env.ALIBABA_APP_SECRET) {
      const sigResult = verifySignature(rawBody, signatureHeader);
      if (!sigResult.valid) {
        logger.warn({ reason: sigResult.reason }, "1688 Callback: Signature invalid");
        await emitEvent(EVENT_KEYS.PURCHASE_PAY_FAILED, {
          postingNumber: "1688_callback",
          error: `签名校验失败: ${sigResult.reason}`,
          channel: "callback",
        });
        res.status(200).send("success");
        return;
      }
    }

    // 2. Parse message
    const parsed = parseMessage(rawBody);
    if (parsed.error) {
      logger.error({ err: parsed.error, rawBody: rawBody.slice(0, 200) }, "1688 Callback: Parse failed");
      res.status(200).send("success");
      return;
    }

    const message = parsed.message!;
    logger.info({ messageId: message.messageId, type: message.type }, "1688 Callback: Received");

    // 3. Redis dedup
    const dup = await isDuplicate(message.messageId);
    if (dup) {
      logger.info({ messageId: message.messageId }, "1688 Callback: Duplicate message, skipped");
      res.status(200).send("success");
      return;
    }

    // 4. Process: match purchase_1688, update status
    try {
      const db = await getDb();
      const result = await processCallbackMessage(message, db);

      if (!result.matched) {
        logger.warn({ messageId: message.messageId, type: message.type, error: result.error }, "1688 Callback: No match");
        await emitEvent(EVENT_KEYS.PURCHASE_PAY_FAILED, {
          postingNumber: message.messageId,
          error: `回调未匹配: ${message.type} — ${result.error || "unknown"}`,
          channel: "callback_unmatched",
        });
      }
    } catch (err) {
      logger.error({ messageId: message.messageId, err: (err as Error).message }, "1688 Callback: Processing error");
      await emitEvent(EVENT_KEYS.PURCHASE_PAY_FAILED, {
        postingNumber: message.messageId,
        error: `回调处理异常: ${(err as Error).message}`,
        channel: "callback_error",
      });
    }

    // 5. Always return "success" (1688 requires plain text)
    res.set("Content-Type", "text/plain").status(200).send("success");
  });

  return router;
}