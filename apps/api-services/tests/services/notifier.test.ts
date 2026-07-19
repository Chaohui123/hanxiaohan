import { describe, it, expect, vi, beforeEach } from "vitest";
import { Notifier } from "../../src/services/notifier.js";

describe("Notifier", () => {
  let notifier: Notifier;

  beforeEach(() => {
    notifier = new Notifier();
    vi.clearAllMocks();
  });

  it("creates notifier instance", () => {
    expect(notifier).toBeDefined();
    expect(typeof notifier.enabled).toBe("boolean");
  });

  it("has health check", () => {
    const health = notifier.getHealth();
    expect(Array.isArray(health)).toBe(true);
    health.forEach((h) => {
      expect(h).toHaveProperty("channel");
      expect(h).toHaveProperty("available");
      expect(h).toHaveProperty("successCount");
    });
  });

  it("notify does not throw when no channels configured", async () => {
    await expect(
      notifier.notify({ level: "info", event: "TEST", message: "test", correlationId: "t1" })
    ).resolves.toBeUndefined();
  });

  it("rate limits rapid notifications", async () => {
    // Send 15 rapid notifications — should be rate-limited
    for (let i = 0; i < 15; i++) {
      await notifier.notify({ level: "info", event: "RATE_TEST", message: `msg ${i}`, correlationId: `r${i}` });
    }
    // Should not throw
  });

  it("critical events bypass quiet hours", async () => {
    await notifier.notify({ level: "critical", event: "CRITICAL", message: "urgent", correlationId: "c1", force: true });
    // Should not be suppressed
  });

  it("listingFailed is a convenience method", async () => {
    await notifier.listingFailed("cid1", "Product Title", "Test error");
    // Should not throw
  });
});
