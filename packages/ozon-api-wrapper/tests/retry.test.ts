// ============================================================
// RetryPolicy unit tests
// ============================================================

import { describe, it, expect } from "vitest";
import { RetryPolicy } from "../src/retry.js";
import { RetryableError, FatalError } from "../src/errors.js";

describe("RetryPolicy", () => {
  it("returns result on success without retrying", async () => {
    const policy = new RetryPolicy({ maxRetries: 3 });
    const result = await policy.execute(async () => "ok");
    expect(result).toBe("ok");
    expect(policy.metrics.totalRetries).toBe(0);
  });

  it("retries on retryable errors and succeeds", async () => {
    const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 10, useJitter: false });
    let attempts = 0;

    const result = await policy.execute(async () => {
      attempts++;
      if (attempts < 2) {
        throw new RetryableError("temp fail", 500);
      }
      return "recovered";
    });

    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
    expect(policy.metrics.totalRetries).toBe(1);
  });

  it("throws after exhausting retries", async () => {
    const policy = new RetryPolicy({ maxRetries: 2, baseDelayMs: 10, useJitter: false });

    await expect(
      policy.execute(async () => {
        throw new RetryableError("always fail", 503);
      })
    ).rejects.toThrow("always fail");

    expect(policy.metrics.totalRetries).toBe(2);
  });

  it("does not retry fatal errors", async () => {
    const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 10, useJitter: false });
    let attempts = 0;

    await expect(
      policy.execute(async () => {
        attempts++;
        throw new FatalError("invalid data", 400);
      })
    ).rejects.toThrow("invalid data");

    expect(attempts).toBe(1); // no retries
    expect(policy.metrics.totalRetries).toBe(0);
  });

  it("isRetryable returns correct values", () => {
    const policy = new RetryPolicy();

    expect(policy.isRetryable(new RetryableError("test", 429))).toBe(true);
    expect(policy.isRetryable(new FatalError("test", 400))).toBe(false);
    expect(policy.isRetryable(new TypeError("network error"))).toBe(true);
  });

  it("calculateDelayMs follows exponential pattern", () => {
    const policy = new RetryPolicy({ baseDelayMs: 1000, maxDelayMs: 10000, useJitter: false });

    // attempt 1: 1s, attempt 2: 2s, attempt 3: 4s
    const d1 = policy.calculateDelayMs(1);
    const d2 = policy.calculateDelayMs(2);
    const d3 = policy.calculateDelayMs(3);

    expect(d1).toBe(1000);
    expect(d2).toBe(2000);
    expect(d3).toBe(4000);
  });

  it("caps delay at maxDelayMs", () => {
    const policy = new RetryPolicy({ baseDelayMs: 1000, maxDelayMs: 3000, useJitter: false });

    const d4 = policy.calculateDelayMs(4); // would be 8000ms without cap
    expect(d4).toBe(3000);
  });
});
