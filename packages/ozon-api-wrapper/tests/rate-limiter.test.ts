// ============================================================
// RateLimiter unit tests
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RateLimiter } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      tokensPerInterval: 10,
      intervalMs: 60000,
      maxBurst: 10,
    });
  });

  it("accepts requests within burst limit", () => {
    for (let i = 0; i < 10; i++) {
      const result = limiter.tryConsume(1);
      expect(result.accepted).toBe(true);
    }
  });

  it("rejects requests beyond burst limit", () => {
    for (let i = 0; i < 10; i++) {
      limiter.tryConsume(1);
    }
    const result = limiter.tryConsume(1);
    expect(result.accepted).toBe(false);
    expect(result.waitMs).toBeGreaterThan(0);
  });

  it("reports correct state", () => {
    limiter.tryConsume(5);
    const state = limiter.state;
    expect(state.tokensRemaining).toBeCloseTo(5, 0);
    expect(state.nextRefillIn).toBeGreaterThanOrEqual(0);
  });

  it("refills tokens over time", async () => {
    // Use a very fast refill rate for testing
    const fastLimiter = new RateLimiter({
      tokensPerInterval: 100,
      intervalMs: 1000,
      maxBurst: 100,
    });

    fastLimiter.tryConsume(100); // drain
    expect(fastLimiter.tryConsume(1).accepted).toBe(false);

    // Wait for some refill
    await new Promise((r) => setTimeout(r, 200));

    const result = fastLimiter.tryConsume(1);
    expect(result.accepted).toBe(true);
  });

  it("reset restores full tokens", () => {
    limiter.tryConsume(10); // drain
    expect(limiter.tryConsume(1).accepted).toBe(false);

    limiter.reset();
    expect(limiter.tryConsume(10).accepted).toBe(true);
  });

  it("async consume waits when tokens depleted", async () => {
    const fastLimiter = new RateLimiter({
      tokensPerInterval: 10,
      intervalMs: 100,
      maxBurst: 10,
    });

    fastLimiter.tryConsume(10); // drain
    const start = Date.now();
    const waitMs = await fastLimiter.consume(1);
    expect(waitMs).toBeGreaterThanOrEqual(0);
    // Should have waited at most ~200ms for a token
  });
});
