// ============================================================
// CircuitBreaker unit tests
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CircuitBreaker, CircuitState } from "../src/circuit-breaker.js";
import { CircuitBreakerOpenError } from "../src/errors.js";

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 1,
      openTimeoutMs: 500, // short for testing
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in CLOSED state", () => {
    expect(cb.state).toBe(CircuitState.CLOSED);
  });

  it("tracks failures and opens after threshold", async () => {
    const fail = async () => { throw new Error("fail"); };

    for (let i = 0; i < 3; i++) {
      try { await cb.call(fail); } catch {}
    }

    expect(cb.state).toBe(CircuitState.OPEN);
    expect(cb.metrics.consecutiveFailures).toBe(3);
  });

  it("rejects calls when OPEN", async () => {
    const fail = async () => { throw new Error("fail"); };

    for (let i = 0; i < 3; i++) {
      try { await cb.call(fail); } catch {}
    }
    expect(cb.state).toBe(CircuitState.OPEN);

    await expect(cb.call(async () => "ok")).rejects.toThrow(CircuitBreakerOpenError);
  });

  it("transitions to HALF_OPEN after timeout", async () => {
    const fail = async () => { throw new Error("fail"); };

    for (let i = 0; i < 3; i++) {
      try { await cb.call(fail); } catch {}
    }
    expect(cb.state).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(600); // past openTimeoutMs

    // Should now be HALF_OPEN
    expect(cb.state).toBe(CircuitState.HALF_OPEN);
  });

  it("closes after successful probe in HALF_OPEN", async () => {
    const fail = async () => { throw new Error("fail"); };

    for (let i = 0; i < 3; i++) {
      try { await cb.call(fail); } catch {}
    }
    expect(cb.state).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(600);
    expect(cb.state).toBe(CircuitState.HALF_OPEN);

    const result = await cb.call(async () => "success");
    expect(result).toBe("success");
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.metrics.consecutiveFailures).toBe(0);
  });

  it("re-opens after failed probe in HALF_OPEN", async () => {
    const fail = async () => { throw new Error("fail"); };

    for (let i = 0; i < 3; i++) {
      try { await cb.call(fail); } catch {}
    }
    expect(cb.state).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(600);
    expect(cb.state).toBe(CircuitState.HALF_OPEN);

    try { await cb.call(fail); } catch {}
    expect(cb.state).toBe(CircuitState.OPEN);
  });

  it("reset clears state", async () => {
    const fail = async () => { throw new Error("fail"); };

    for (let i = 0; i < 3; i++) {
      try { await cb.call(fail); } catch {}
    }
    expect(cb.state).toBe(CircuitState.OPEN);

    cb.reset();
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.metrics.consecutiveFailures).toBe(0);

    const result = await cb.call(async () => "ok");
    expect(result).toBe("ok");
  });

  it("forceState changes state manually", () => {
    cb.forceState(CircuitState.OPEN);
    expect(cb.state).toBe(CircuitState.OPEN);
    cb.forceState(CircuitState.CLOSED);
    expect(cb.state).toBe(CircuitState.CLOSED);
  });
});
