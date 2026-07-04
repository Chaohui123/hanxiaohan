// ============================================================
// Ozon Webhook Handler — push notification consumer
// Event dedup, signature verification, masked logging
// ============================================================

import crypto from "node:crypto";
import type { OzonOrderStatus } from "@onzo/shared-types";

export type WebhookEventType = "order.created" | "order.status_changed" | "order.cancelled" | "order.delivered";

export interface WebhookPayload {
  eventId: string;          // unique per notification
  eventType: WebhookEventType;
  postingNumber: string;
  orderId: number;
  status: OzonOrderStatus;
  timestamp: string;
  rawBody: string;
  signature?: string;       // HMAC-SHA256 from Ozon
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

  if (computed !== signature) {
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
  // Verify signature if secret provided
  if (signature && apiSecret) {
    const result = verifySignature(rawBody, signature, apiSecret);
    if (!result.valid) return result;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { valid: false, reason: "Invalid JSON body" };
  }

  const eventId = (parsed.event_id || parsed.id || crypto.randomUUID()) as string;
  const eventType = (parsed.event_type || parsed.type || "order.status_changed") as string;

  // Dedup check
  if (await isDuplicate(eventId, options?.dedupStore)) {
    return { valid: false, reason: "Duplicate event (already processed)" };
  }

  // Validate required fields
  const postingNumber = (parsed.posting_number || parsed.postingNumber) as string | undefined;
  if (!postingNumber) {
    return { valid: false, reason: "Missing posting_number" };
  }

  markProcessed(eventId, options?.dedupStore);
  if (options?.dedupStore) {
    await options.dedupStore.markProcessed(eventId, { postingNumber, eventType });
  }

  return {
    eventId,
    eventType: eventType as WebhookEventType,
    postingNumber,
    orderId: (parsed.order_id || parsed.orderId || 0) as number,
    status: ((parsed.status || parsed.new_status || "delivering") as string) as OzonOrderStatus,
    timestamp: (parsed.timestamp as string) || new Date().toISOString(),
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
  }
): Promise<void> {
  switch (payload.eventType) {
    case "order.delivered":
      await actions.onDelivered?.(payload);
      break;
    case "order.cancelled":
      await actions.onCancelled?.(payload);
      break;
    case "order.status_changed":
    case "order.created":
    default:
      await actions.onStatusChanged?.(payload);
      break;
  }
}
