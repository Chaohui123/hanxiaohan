// ============================================================
// Dead Letter Auto-Retry Tests — jobs/deadletter-retry.ts
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  retryDeadLetters: vi.fn(),
  emitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/dead-letter.js", () => ({
  retryDeadLetters: mocks.retryDeadLetters,
}));
vi.mock("../../src/services/notification-events.js", () => ({
  emitEvent: mocks.emitEvent,
  EVENT_KEYS: { DEAD_LETTER_RETRY: "DEAD_LETTER_RETRY" },
}));

import { autoRetryDeadLetters } from "../../src/jobs/deadletter-retry.js";

const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("autoRetryDeadLetters", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs retryDeadLetters once per retryable category with default limit 50", async () => {
    mocks.retryDeadLetters.mockResolvedValue({ retried: 0, failed: 0, total: 0 });

    await autoRetryDeadLetters({ logger: fakeLogger });

    expect(mocks.retryDeadLetters).toHaveBeenCalledTimes(4);
    const categories = mocks.retryDeadLetters.mock.calls.map((c) => (c[0] as { filterCategory: string }).filterCategory);
    expect(categories).toEqual(["api_error", "network", "rate_limit", "circuit_breaker"]);
    for (const call of mocks.retryDeadLetters.mock.calls) {
      expect((call[0] as { limit: number }).limit).toBe(50);
    }
  });

  it("does not touch validation/permanent categories", async () => {
    mocks.retryDeadLetters.mockResolvedValue({ retried: 0, failed: 0, total: 0 });

    await autoRetryDeadLetters({ logger: fakeLogger });

    const categories = mocks.retryDeadLetters.mock.calls.map((c) => (c[0] as { filterCategory: string }).filterCategory);
    expect(categories).not.toContain("validation");
    expect(categories).not.toContain("unknown");
  });

  it("aggregates results across categories", async () => {
    mocks.retryDeadLetters
      .mockResolvedValueOnce({ retried: 3, failed: 0, total: 3 })
      .mockResolvedValueOnce({ retried: 2, failed: 1, total: 4 })
      .mockResolvedValueOnce({ retried: 0, failed: 0, total: 0 })
      .mockResolvedValueOnce({ retried: 1, failed: 0, total: 1 });

    const summary = await autoRetryDeadLetters({ logger: fakeLogger });

    expect(summary).toEqual({ retried: 6, failed: 1, total: 8 });
  });

  it("emits summary event when tasks were retried", async () => {
    mocks.retryDeadLetters.mockResolvedValue({ retried: 2, failed: 0, total: 2 });

    await autoRetryDeadLetters({ logger: fakeLogger });

    expect(mocks.emitEvent).toHaveBeenCalledWith("DEAD_LETTER_RETRY", {
      retried: "8", failed: "0", total: "8",
    });
  });

  it("emits summary event when retries failed", async () => {
    mocks.retryDeadLetters.mockResolvedValue({ retried: 0, failed: 1, total: 1 });

    await autoRetryDeadLetters({ logger: fakeLogger });

    expect(mocks.emitEvent).toHaveBeenCalledWith("DEAD_LETTER_RETRY", expect.objectContaining({ failed: "4" }));
  });

  it("stays quiet when nothing was retried or failed", async () => {
    mocks.retryDeadLetters.mockResolvedValue({ retried: 0, failed: 0, total: 5 });

    const summary = await autoRetryDeadLetters({ logger: fakeLogger });

    expect(mocks.emitEvent).not.toHaveBeenCalled();
    expect(summary.total).toBe(20); // 5 per category × 4 categories
  });

  it("respects a custom limit", async () => {
    mocks.retryDeadLetters.mockResolvedValue({ retried: 0, failed: 0, total: 0 });

    await autoRetryDeadLetters({ logger: fakeLogger, limit: 10 });

    for (const call of mocks.retryDeadLetters.mock.calls) {
      expect((call[0] as { limit: number }).limit).toBe(10);
    }
  });
});
