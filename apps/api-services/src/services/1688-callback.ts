// ============================================================
// 1688 Message Callback Handler — signature verification,
// message type parsing, purchase_1688 matching, dedup
// ============================================================

import { createHmac, timingSafeEqual } from "node:crypto";
import type { DbAdapter } from "../db/connection.js";
import { cache } from "@onzo/cache";
import { logger } from "@onzo/logger";
import { emitEvent, EVENT_KEYS } from "./notification-events.js";

// ---- Types ----

/** 1688 push message types */
export type MessageType =
  | "ORDER_CREATED"       // 采购单创建
  | "ORDER_PAID"          // 支付完成
  | "SUPPLIER_SHIPPED"    // 供应商发货
  | "LOGISTICS_UPDATE"    // 物流更新
  | "ORDER_CANCELLED"     // 采购单取消
  | "REFUND_COMPLETED";   // 退款完成

export interface CallbackMessage {
  messageId: string;        // 1688 message unique ID
  type: MessageType;
  timestamp: string;        // ISO
  orderId?: string;         // 1688 purchase order ID
  paySerial?: string;       // payment serial
  trackingNumber?: string;  // logistics tracking
  logisticsStatus?: string; // logistics detail
  amountCny?: number;
  rawBody: string;          // original JSON for audit
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  message?: CallbackMessage;
}

// ---- Config ----

const APP_SECRET = process.env.ALIBABA_APP_SECRET || "";
/** 1688 callback source IPs (optional whitelist) */
const ALLOWED_IPS = (process.env.ALIBABA_CALLBACK_IPS || "110.75.0.0/16,47.96.0.0/12")
  .split(",").map((s) => s.trim()).filter(Boolean);

// ---- Signature Verification ----

/**
 * Verify 1688 message signature (HMAC-SHA256).
 * 1688 signs the raw JSON body with the app secret.
 * Signature format: header `X-1688-Signature: algorithm=HMAC-SHA256, sign=xxx`
 */
export function verifySignature(rawBody: string, signatureHeader: string): VerifyResult {
  if (!APP_SECRET) {
    // No secret configured — accept all (dev mode)
    logger.warn("1688 Callback: ALIBABA_APP_SECRET not set — skipping signature check");
    return { valid: true };
  }

  if (!signatureHeader) {
    return { valid: false, reason: "Missing X-1688-Signature header" };
  }

  try {
    // Parse: "algorithm=HMAC-SHA256, sign=abc123..."
    const parts = signatureHeader.split(",").map((s) => s.trim());
    const algoPart = parts.find((p) => p.startsWith("algorithm="));
    const signPart = parts.find((p) => p.startsWith("sign="));

    if (!signPart) {
      return { valid: false, reason: "Invalid signature format — missing sign=" };
    }

    const expectedAlgo = algoPart?.split("=")[1] || "HMAC-SHA256";
    const receivedSign = signPart.split("=")[1];

    if (!receivedSign) {
      return { valid: false, reason: "Empty signature value" };
    }

    const computed = createHmac("sha256", APP_SECRET).update(rawBody, "utf-8").digest("hex").toUpperCase();
    const received = Buffer.from(receivedSign, "hex");
    const expected = Buffer.from(computed, "hex");

    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return { valid: false, reason: `Signature mismatch (expected ${expectedAlgo})` };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `Signature verification error: ${(err as Error).message}` };
  }
}

// ---- Message Parsing ----

/**
 * Parse raw 1688 callback JSON into structured CallbackMessage.
 * 1688 sends messages in format:
 * { "message_id": "...", "type": "ORDER_PAID", "timestamp": "...", "data": { ... } }
 */
export function parseMessage(rawBody: string): { message?: CallbackMessage; error?: string } {
  try {
    const body = JSON.parse(rawBody) as Record<string, unknown>;

    const messageId = (body.message_id as string) || (body.msg_id as string) || "";
    if (!messageId) {
      return { error: "Missing message_id in callback body" };
    }

    const type = ((body.type as string) || "").toUpperCase() as MessageType;
    if (!type) {
      return { error: "Missing type in callback body" };
    }

    const data = (body.data || {}) as Record<string, unknown>;

    const message: CallbackMessage = {
      messageId,
      type,
      timestamp: (body.timestamp as string) || new Date().toISOString(),
      orderId: (data.order_id as string) || (data.orderId as string),
      paySerial: (data.pay_serial as string) || (data.paySerial as string),
      trackingNumber: (data.tracking_number as string) || (data.trackingNumber as string),
      logisticsStatus: (data.logistics_status as string) || (data.logisticsStatus as string),
      amountCny: Number(data.amount) || Number(data.amount_cny) || undefined,
      rawBody,
    };

    return { message };
  } catch (err) {
    return { error: `JSON parse error: ${(err as Error).message}` };
  }
}

// ---- IP Whitelist ----

function isIpAllowed(clientIp: string): boolean {
  if (ALLOWED_IPS.length === 0) return true;
  return ALLOWED_IPS.some((allowed) => {
    if (!allowed.includes("/")) return clientIp === allowed;
    const [network, bitsStr] = allowed.split("/");
    const bits = parseInt(bitsStr, 10);
    const clientParts = clientIp.split(".").map(Number);
    const netParts = network.split(".").map(Number);
    const matchBytes = Math.floor(bits / 8);
    for (let i = 0; i < matchBytes; i++) {
      if (clientParts[i] !== netParts[i]) return false;
    }
    return true;
  });
}

/** Check IP whitelist (if configured). Call before processing. */
export function checkCallbackIp(clientIp: string): { allowed: boolean; reason?: string } {
  if (ALLOWED_IPS.length === 0) return { allowed: true };
  const allowed = isIpAllowed(clientIp);
  if (!allowed) {
    logger.warn({ clientIp }, "1688 Callback: IP not in whitelist");
  }
  return { allowed, reason: allowed ? undefined : `IP ${clientIp} not in whitelist` };
}

// ---- Redis Dedup ----

const DEDUP_PREFIX = "1688:callback:dedup:";
const DEDUP_TTL_MS = 24 * 3600 * 1000; // 24 hours

/** Check if message was already processed. Returns true if duplicate. */
export async function isDuplicate(messageId: string): Promise<boolean> {
  const key = `${DEDUP_PREFIX}${messageId}`;
  const locked = await cache.setnx(key, "1", DEDUP_TTL_MS);
  return !locked; // if setnx returns false, key already exists → duplicate
}

// ---- Purchase Matching & Status Update ----

/**
 * Process a verified callback message: match to purchase_1688 record,
 * update status, and trigger downstream logistics.
 */
export async function processCallbackMessage(
  message: CallbackMessage,
  db: DbAdapter | null,
): Promise<{ matched: boolean; action: string; error?: string }> {
  if (!db) return { matched: false, action: "none", error: "DB unavailable" };

  switch (message.type) {
    case "ORDER_CREATED": {
      // Update purchase_1688 status → pending (order created on 1688 side)
      if (!message.orderId) return { matched: false, action: "none", error: "Missing orderId" };
      const result = await db.run(
        "UPDATE purchase_1688 SET payment_status = 'pending', updated_at = datetime('now') WHERE ozon_posting_number LIKE ? AND payment_status = 'pending'",
        [`%${message.orderId.slice(-12)}%`]
      );
      return { matched: result.changes > 0, action: "set_pending", error: result.changes === 0 ? "No matching purchase record" : undefined };
    }

    case "ORDER_PAID": {
      if (!message.paySerial) return { matched: false, action: "none", error: "Missing paySerial" };
      const result = await db.run(
        "UPDATE purchase_1688 SET payment_status = 'paid', pay_serial = ?, pay_time = ?, updated_at = datetime('now') WHERE pay_serial = ? AND payment_status != 'paid'",
        [message.paySerial, message.timestamp, message.paySerial]
      );
      if (result.changes > 0) {
        await emitEvent(EVENT_KEYS.PURCHASE_PAY_SUCCESS, {
          postingNumber: message.paySerial,
          amountCny: String(message.amountCny || 0),
          channel: "1688_callback",
        });
      }
      return { matched: result.changes > 0, action: "mark_paid", error: result.changes === 0 ? "No matching purchase record" : undefined };
    }

    case "SUPPLIER_SHIPPED": {
      if (!message.trackingNumber) return { matched: false, action: "none", error: "Missing trackingNumber" };
      const result = await db.run(
        "UPDATE purchase_1688 SET logistics_status = 'shipped', logistics_tracking = ?, updated_at = datetime('now') WHERE logistics_tracking IS NULL AND payment_status = 'paid'",
        [message.trackingNumber]
      );
      if (result.changes > 0) {
        await emitEvent("ORDER_SHIPPED", {
          postingNumber: message.trackingNumber,
          trackingNumber: message.trackingNumber,
        });
      }
      return { matched: result.changes > 0, action: "logistics_shipped", error: result.changes === 0 ? "No matching paid purchase" : undefined };
    }

    case "LOGISTICS_UPDATE": {
      if (!message.trackingNumber) return { matched: false, action: "none", error: "Missing trackingNumber" };
      const result = await db.run(
        "UPDATE purchase_1688 SET logistics_status = ?, logistics_tracking = ?, updated_at = datetime('now') WHERE logistics_tracking = ?",
        [message.logisticsStatus || "in_transit", message.trackingNumber, message.trackingNumber]
      );
      return { matched: result.changes > 0, action: "logistics_update", error: result.changes === 0 ? "No matching tracking" : undefined };
    }

    case "ORDER_CANCELLED": {
      if (!message.orderId) return { matched: false, action: "none", error: "Missing orderId" };
      const result = await db.run(
        "UPDATE purchase_1688 SET payment_status = 'cancelled', pay_error = '1688订单取消', updated_at = datetime('now') WHERE ozon_posting_number LIKE ? AND payment_status = 'pending'",
        [`%${message.orderId.slice(-12)}%`]
      );
      return { matched: result.changes > 0, action: "cancel", error: result.changes === 0 ? "No matching purchase" : undefined };
    }

    case "REFUND_COMPLETED": {
      if (!message.paySerial) return { matched: false, action: "none", error: "Missing paySerial" };
      const result = await db.run(
        "UPDATE purchase_1688 SET payment_status = 'refunded', pay_error = '1688退款', updated_at = datetime('now') WHERE pay_serial = ?",
        [message.paySerial]
      );
      return { matched: result.changes > 0, action: "refund", error: result.changes === 0 ? "No matching payment" : undefined };
    }

    default:
      return { matched: false, action: "unknown_type", error: `Unknown message type: ${message.type}` };
  }
}