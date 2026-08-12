// ============================================================
// Ozon Webhook Handler — push notification consumer
// Event dedup, signature verification, masked logging
// ============================================================

import crypto from "node:crypto";
import type { OzonOrderStatus } from "@onzo/shared-types";

export type WebhookEventType =
  | "order.created"
  | "order.status_changed"
  | "order.cancelled"
  | "order.delivered"
  | "message.received"   // buyer / seller-chat message (TYPE_NEW_MESSAGE)
  | "ignored";           // known non-order events (stocks, category tree, item updates...)

/**
 * Real Ozon push payloads use `message_type` (observed in production 2026-08):
 *   TYPE_ORDER_NEW / TYPE_ORDER_STATE_CHANGED / TYPE_ORDER_CANCELLED /
 *   TYPE_NEW_MESSAGE / TYPE_STOCKS_CHANGED / TYPE_CREATE_OR_UPDATE_ITEM /
 *   TYPE_DESCRIPTION_CATEGORY_TREE_CHANGED
 * and identify the order with `order_number` (not `posting_number`),
 * the event with `uuid` (not `event_id`). Ozon pushes do NOT carry an
 * X-Ozon-Signature header — signature verification only applies when a
 * signature is actually present.
 */
const MESSAGE_TYPE_MAP: Record<string, WebhookEventType> = {
  TYPE_ORDER_NEW: "order.created",
  TYPE_ORDER_STATE_CHANGED: "order.status_changed",
  TYPE_ORDER_CANCELLED: "order.cancelled",
  TYPE_ORDER_DELIVERED: "order.delivered",
  TYPE_NEW_MESSAGE: "message.received",
  // Internal type names pass through unchanged (legacy format compatibility)
  "order.created": "order.created",
  "order.status_changed": "order.status_changed",
  "order.cancelled": "order.cancelled",
  "order.delivered": "order.delivered",
  "message.received": "message.received",
};

function resolveEventType(raw: string): WebhookEventType {
  return MESSAGE_TYPE_MAP[raw] ?? "ignored";
}

export interface WebhookPayload {
  eventId: string;          // unique per notification
  eventType: WebhookEventType;
  postingNumber: string;
  orderId: number;
  status: OzonOrderStatus;
  timestamp: string;
  rawBody: string;
  signature?: string;       // HMAC-SHA256 from Ozon (rarely present)
}

export interface WebhookVerifyResult {
  valid: boolean;
  reason?: string;
}

export interface WebhookDedupStore {
  isDuplicate(eventId: string): Promise<boolean> | boolean;
  markProcessed(eventId: string, meta?: { postingNumber?: string; eventType?: string }): Promise<void> | void;
}

/** Set of recently processed event IDs for dedup (in-memory, with TTL). */
const processedEvents = new Map<string, number>(); // eventId → expiry timestamp
const EVENT_TTL_MS = 24 * 3600 * 1000; // 24 hours

async function isDuplicate(eventId: string, dedupStore?: WebhookDedupStore): Promise<boolean> {
  if (dedupStore) {
    return await dedupStore.isDuplicate(eventId);
  }

  const expiry = processedEvents.get(eventId);
  if (expiry && expiry > Date.now()) return true;
  // Clean up expired entries
  for (const [id, exp] of processedEvents) {
    if (exp <= Date.now()) processedEvents.delete(id);
  }
  return false;
}

function markProcessed(eventId: string, dedupStore?: WebhookDedupStore): void {
  if (dedupStore) {
    void dedupStore.markProcessed(eventId);
    return;
  }

  processedEvents.set(eventId, Date.now() + EVENT_TTL_MS);
}

/**
 * Verify Ozon webhook signature.
 * Ozon signs with HMAC-SHA256 using the API key as secret.
 */
export function verifySignature(
  rawBody: string,
  signature: string,
  apiSecret: string
): WebhookVerifyResult {
  if (!signature) {
    return { valid: false, reason: "Missing signature header" };
  }

  const computed = crypto
    .createHmac("sha256", apiSecret)
    .update(rawBody)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  const computedBuf = Buffer.from(computed, "hex");
  const signatureBuf = Buffer.from(signature, "hex");

  if (
    computedBuf.length !== signatureBuf.length ||
    !crypto.timingSafeEqual(computedBuf, signatureBuf)
  ) {
    return { valid: false, reason: "Signature mismatch" };
  }

  return { valid: true };
}

/**
 * Parse and validate an incoming Ozon webhook.
 */
export async function parseWebhookPayload(
  rawBody: string,
  signature?: string,
  apiSecret?: string,
  options?: { dedupStore?: WebhookDedupStore }
): Promise<WebhookPayload | WebhookVerifyResult> {
  // Verify signature — mandatory when signature header is present
  if (signature) {
    if (!apiSecret) {
      return { valid: false, reason: "Signature provided but no API secret configured" };
    }
    const result = verifySignature(rawBody, signature, apiSecret);
    if (!result.valid) return result;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { valid: false, reason: "Invalid JSON body" };
  }

  // Real Ozon pushes: `uuid` is the event id, `message_type` the event type.
  // Legacy/internal format: `event_id` / `event_type` (or `type`).
  const eventId = (parsed.uuid || parsed.event_id || parsed.id || crypto.randomUUID()) as string;
  const rawType = (parsed.message_type || parsed.event_type || parsed.type || "order.status_changed") as string;
  const eventType = resolveEventType(rawType);

  // Ignored events (stocks/category-tree/item updates...): ack without dedup
  // or posting_number requirements — the receiver logs but does not queue them.
  if (eventType === "ignored") {
    return {
      eventId,
      eventType,
      postingNumber: "",
      orderId: 0,
      status: "delivering" as OzonOrderStatus,
      timestamp: (parsed.changed_at as string) || new Date().toISOString(),
      rawBody,
      signature,
    };
  }

  // Dedup check
  if (await isDuplicate(eventId, options?.dedupStore)) {
    return { valid: false, reason: "Duplicate event (already processed)" };
  }

  // Real Ozon pushes identify the order with `order_number`.
  // message.received events carry no order reference — postingNumber stays empty.
  const postingNumber = (parsed.posting_number || parsed.order_number || parsed.postingNumber || "") as string;
  if (eventType !== "message.received" && !postingNumber) {
    return { valid: false, reason: "Missing posting_number" };
  }

  markProcessed(eventId, options?.dedupStore);
  if (options?.dedupStore) {
    await options.dedupStore.markProcessed(eventId, { postingNumber, eventType });
  }

  return {
    eventId,
    eventType,
    postingNumber,
    orderId: (parsed.order_id || parsed.orderId || 0) as number,
    status: ((parsed.status || parsed.new_status || parsed.new_state || "delivering") as string) as OzonOrderStatus,
    timestamp: (parsed.timestamp as string) || (parsed.creation_date as string) || (parsed.cancelled_at as string) || new Date().toISOString(),
    rawBody,
    signature,
  };
}

/**
 * Handle a webhook event — route to appropriate action.
 */
export async function handleWebhookEvent(
  payload: WebhookPayload,
  actions: {
    onStatusChanged?: (p: WebhookPayload) => Promise<void>;
    onDelivered?: (p: WebhookPayload) => Promise<void>;
    onCancelled?: (p: WebhookPayload) => Promise<void>;
    onMessage?: (p: WebhookPayload) => Promise<void>;
  }
): Promise<void> {
  switch (payload.eventType) {
    case "order.delivered":
      await actions.onDelivered?.(payload);
      break;
    case "order.cancelled":
      await actions.onCancelled?.(payload);
      break;
    case "message.received":
      await actions.onMessage?.(payload);
      break;
    case "ignored":
      break; // known non-order event — nothing to do
    case "order.status_changed":
    case "order.created":
      await actions.onStatusChanged?.(payload);
      break;
  }
}
