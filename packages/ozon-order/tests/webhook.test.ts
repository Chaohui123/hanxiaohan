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
  it("parses valid Ozon webhook", () => {
    const body = JSON.stringify({
      event_id: "evt-001",
      event_type: "order.status_changed",
      posting_number: "P123-ABC",
      order_id: 456,
      new_status: "delivering",
    });

    const result = parseWebhookPayload(body);
    expect("eventId" in result).toBe(true);
    if ("eventId" in result) {
      expect(result.eventId).toBe("evt-001");
      expect(result.postingNumber).toBe("P123-ABC");
      expect(result.status).toBe("delivering");
    }
  });

  it("deduplicates repeated events", () => {
    const body = JSON.stringify({
      event_id: "evt-002-dedup",
      event_type: "order.delivered",
      posting_number: "P456-DEF",
      status: "delivered",
    });

    // First call
    const r1 = parseWebhookPayload(body);
    expect("eventId" in r1).toBe(true);

    // Second call with same event_id
    const r2 = parseWebhookPayload(body);
    expect("eventId" in r2).toBe(false);
    if (!("eventId" in r2)) {
      expect(r2.reason).toBe("Duplicate event (already processed)");
    }
  });

  it("rejects invalid JSON", () => {
    const result = parseWebhookPayload("not json");
    expect("eventId" in result).toBe(false);
    if (!("eventId" in result)) {
      expect(result.reason).toBe("Invalid JSON body");
    }
  });

  it("rejects missing posting_number", () => {
    const result = parseWebhookPayload(JSON.stringify({ event_id: "x" }));
    expect("eventId" in result).toBe(false);
    if (!("eventId" in result)) {
      expect(result.reason).toBe("Missing posting_number");
    }
  });
});
