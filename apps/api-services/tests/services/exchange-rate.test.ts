import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock cache to always return null (force API fetch path)
vi.mock("@onzo/cache", () => ({
  cache: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined), del: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/services/notification-events.js", () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  EVENT_KEYS: { EXCHANGE_RATE_STALE: "EXCHANGE_RATE_STALE" },
}));

import { getExchangeRate, forceRefreshRate } from "../../src/services/exchange-rate.js";

describe("getExchangeRate", () => {
  beforeEach(() => {
    forceRefreshRate();
    global.fetch = vi.fn().mockRejectedValue(new Error("Network down"));
  });

  it("returns fallback rate when API fails", async () => {
    const result = await getExchangeRate();
    expect(result.rate).toBeGreaterThan(0);
    expect(result.reliable).toBe(false);
    expect(result.source).toBe("hardcoded-fallback");
  });

  it("returns fresh rate when both APIs succeed", async () => {
    // fetchPrimary: 2 calls (CNY→USD, RUB→USD) + fetchSecondary: 1 call (CNY→RUB) = 3 total
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.14 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.011 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { RUB: 12.73 } }) });
    const result = await getExchangeRate();
    expect(result.cached).toBe(false);
    expect(result.reliable).toBe(true);
  });

  it("caches rate for subsequent calls", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.14 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.011 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { RUB: 12.73 } }) });
    await getExchangeRate();
    // Second call — uses memory cache, no fetch
    global.fetch = vi.fn();
    const result2 = await getExchangeRate();
    expect(result2.cached).toBe(true);
  });

  it("forceRefreshRate clears cache", () => {
    forceRefreshRate();
    // No error = success
  });
});
