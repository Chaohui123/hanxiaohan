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
