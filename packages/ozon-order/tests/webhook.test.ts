import { describe, it, expect } from "vitest";
import { parseWebhookPayload, verifySignature } from "../src/webhook.js";

const SECRET = "test-secret-key";

describe("Webhook signature verification", () => {
  it("verifies valid HMAC-SHA256 signature", () => {
    const body = JSON.stringify({ posting_number: "123-abc", status: "delivered" });
    const crypto = require("crypto") as typeof import("crypto");
    const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");

    const result = verifySignature(body, sig, SECRET);
    expect(result.valid).toBe(true);
  });

  it("rejects mismatched signature", () => {
    const body = JSON.stringify({ posting_number: "123-abc" });
    const result = verifySignature(body, "bad_signature", SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("Signature mismatch");
  });

  it("rejects missing signature", () => {
    const result = verifySignature("body", "", SECRET);
    expect(result.valid).toBe(false);
  });
});

describe("Webhook payload parsing", () => {
  it("parses valid Ozon webhook", async () => {
    const body = JSON.stringify({
      event_id: "evt-001",
      event_type: "order.status_changed",
      posting_number: "P123-ABC",
      order_id: 456,
      new_status: "delivering",
    });

    const result = await parseWebhookPayload(body);
    expect("eventId" in result).toBe(true);
    if ("eventId" in result) {
      expect(result.eventId).toBe("evt-001");
      expect(result.postingNumber).toBe("P123-ABC");
      expect(result.status).toBe("delivering");
    }
  });

  it("deduplicates repeated events", async () => {
    const body = JSON.stringify({
      event_id: "evt-002-dedup-2",
      event_type: "order.delivered",
      posting_number: "P456-DEF",
      status: "delivered",
    });

    const r1 = await parseWebhookPayload(body);
    expect("eventId" in r1).toBe(true);

    const r2 = await parseWebhookPayload(body);
    expect("eventId" in r2).toBe(false);
    if (!("eventId" in r2)) {
      expect(r2.reason).toBe("Duplicate event (already processed)");
    }
  });

  it("rejects invalid JSON", async () => {
    const result = await parseWebhookPayload("not json");
    expect("eventId" in result).toBe(false);
    if (!("eventId" in result)) {
      expect(result.reason).toBe("Invalid JSON body");
    }
  });

  it("rejects missing posting_number", async () => {
    const result = await parseWebhookPayload(JSON.stringify({ event_id: "x" }));
    expect("eventId" in result).toBe(false);
    if (!("eventId" in result)) {
      expect(result.reason).toBe("Missing posting_number");
    }
  });
});

// Real Ozon push format observed in production 2026-08:
// message_type / order_number / uuid fields, no signature header.
describe("Real Ozon push format (production 2026-08)", () => {
  it("parses TYPE_ORDER_NEW without signature", async () => {
    const body = JSON.stringify({
      message_type: "TYPE_ORDER_NEW",
      order_number: "0148010868-0049",
      order_id: 38394336004,
      uuid: "9ede66ab-3821-4111-8507-dc2978a50ef4",
      creation_date: "2026-08-10T03:28:28.425018Z",
    });

    const result = await parseWebhookPayload(body);
    expect("eventId" in result).toBe(true);
    if ("eventId" in result) {
      expect(result.eventId).toBe("9ede66ab-3821-4111-8507-dc2978a50ef4");
      expect(result.eventType).toBe("order.created");
      expect(result.postingNumber).toBe("0148010868-0049");
      expect(result.orderId).toBe(38394336004);
    }
  });

  it("parses TYPE_ORDER_CANCELLED with seller_id", async () => {
    const body = JSON.stringify({
      message_type: "TYPE_ORDER_CANCELLED",
      order_number: "0148010868-0049",
      order_id: 38394336004,
      uuid: "1ba88f2e-288f-4e98-bf35-3bf44c5d3bf9",
      cancelled_at: "2026-08-11T12:49:29.787Z",
      seller_id: 5140601,
    });

    const result = await parseWebhookPayload(body);
    expect("eventId" in result).toBe(true);
    if ("eventId" in result) {
      expect(result.eventType).toBe("order.cancelled");
      expect(result.postingNumber).toBe("0148010868-0049");
      expect(result.timestamp).toBe("2026-08-11T12:49:29.787Z");
    }
  });

  it("parses TYPE_ORDER_STATE_CHANGED using new_state", async () => {
    const body = JSON.stringify({
      message_type: "TYPE_ORDER_STATE_CHANGED",
      order_number: "0148010868-0049",
      order_id: 38394336004,
      uuid: "af22bc42-6985-4c11-9bb7-4250cd2c1d56",
      old_state: "order_registered",
      new_state: "delivering",
    });

    const result = await parseWebhookPayload(body);
    expect("eventId" in result).toBe(true);
    if ("eventId" in result) {
      expect(result.eventType).toBe("order.status_changed");
      expect(result.status).toBe("delivering");
    }
  });

  it("parses TYPE_NEW_MESSAGE without posting number", async () => {
    const body = JSON.stringify({
      message_type: "TYPE_NEW_MESSAGE",
      message_id: "3000000438893744391",
      chat_id: "5fa14699-57d6-46e9-bfd7-9eea47261dc7",
      chat_type: "Seller_Notification_FBS",
      uuid: "c2a6d111-1111-4111-8111-111111111111",
    });

    const result = await parseWebhookPayload(body);
    expect("eventId" in result).toBe(true);
    if ("eventId" in result) {
      expect(result.eventType).toBe("message.received");
      expect(result.postingNumber).toBe("");
    }
  });

  it("marks known non-order events as ignored without dedup", async () => {
    const body = JSON.stringify({
      message_type: "TYPE_STOCKS_CHANGED",
      seller_id: 5140601,
      items: [{ product_id: 5795139207, sku: 5328928186 }],
    });

    const r1 = await parseWebhookPayload(body);
    expect("eventId" in r1).toBe(true);
    if ("eventId" in r1) expect(r1.eventType).toBe("ignored");

    // No dedup for ignored events — same body parses again
    const r2 = await parseWebhookPayload(body);
    expect("eventId" in r2).toBe(true);
  });

  it("deduplicates real events by uuid", async () => {
    const body = JSON.stringify({
      message_type: "TYPE_ORDER_NEW",
      order_number: "0148010868-9999",
      order_id: 38394336099,
      uuid: "dedup-uuid-0000-4111-8111-111111111111",
    });

    const r1 = await parseWebhookPayload(body);
    expect("eventId" in r1).toBe(true);
    const r2 = await parseWebhookPayload(body);
    expect("eventId" in r2).toBe(false);
    if (!("eventId" in r2)) {
      expect(r2.reason).toBe("Duplicate event (already processed)");
    }
  });
});
