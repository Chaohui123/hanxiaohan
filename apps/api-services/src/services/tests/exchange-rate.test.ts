import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture mocked cache get/set to allow per-test overrides
const mockCacheGet = vi.fn().mockResolvedValue(null);
const mockCacheSet = vi.fn().mockResolvedValue(undefined);
const mockCacheDel = vi.fn().mockResolvedValue(undefined);

vi.mock("@onzo/cache", () => ({
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
    del: (...args: unknown[]) => mockCacheDel(...args),
  },
  TTL: { EXCHANGE_RATE: 3600 },
}));
vi.mock("../notification-events.js", () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  EVENT_KEYS: { EXCHANGE_RATE_STALE: "EXCHANGE_RATE_STALE" },
}));

import { getExchangeRate, forceRefreshRate } from "../exchange-rate.js";

describe("getExchangeRate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forceRefreshRate();
    global.fetch = vi.fn().mockRejectedValue(new Error("Network down"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns fallback rate when all APIs fail with no cache", async () => {
    const result = await getExchangeRate();
    expect(result.rate).toBe(11.5);
    expect(result.reliable).toBe(false);
    expect(result.source).toBe("hardcoded-fallback");
  });

  it("returns fresh rate when both APIs succeed (dual-source)", async () => {
    // fetchPrimary: 2 calls (CNY→USD, RUB→USD) + fetchSecondary: 1 call (CNY→RUB) = 3 total
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.14 } }) })    // CNY→USD
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.011 } }) })   // RUB→USD
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { RUB: 12.73 } }) });   // frankfurter CNY→RUB
    const r = await getExchangeRate();
    expect(r.cached).toBe(false);
    expect(r.reliable).toBe(true);
    expect(r.source).toBe("dual");
  });

  it("detects deviation >5% between sources", async () => {
    // Primary: 0.14/0.009 ≈ 15.56, Secondary: 12.5 → deviation ≈ 19.7%
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.14 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.009 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { RUB: 12.5 } }) });
    const r = await getExchangeRate();
    expect(r.reliable).toBe(false);
  });

  it("uses memory cache on second call", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.14 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.011 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { RUB: 12.73 } }) });
    await getExchangeRate();
    global.fetch = vi.fn();
    const r2 = await getExchangeRate();
    expect(r2.cached).toBe(true);
  });

  it("forceRefreshRate clears cache", () => {
    forceRefreshRate();
  });

  // ---- Staleness logic tests — Redis cache path ----

  it("Redis cache < 24h: reliable=true, stale=false", async () => {
    const recentTs = Date.now() - 30 * 60_000; // 30 min ago, within 1h TTL
    mockCacheGet.mockResolvedValue(JSON.stringify({ rate: 12.5, timestamp: recentTs, source: "test" }));

    const r = await getExchangeRate();
    expect(r.reliable).toBe(true);
    expect(r.stale).toBe(false);
    expect(r.cached).toBe(true);
    expect(r.rate).toBe(12.5);
  });

  it("localCache with APIs failed: returns stale but reliable when < 48h", async () => {
    // Seed memory cache via a successful API call (3 fetch calls)
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.14 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.011 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { RUB: 12.73 } }) });
    await getExchangeRate();

    // APIs now fail, but localCache is still fresh
    global.fetch = vi.fn().mockRejectedValue(new Error("down"));
    const r = await getExchangeRate();
    expect(r.cached).toBe(true);
    expect(r.reliable).toBe(true); // < 1h, still fresh
  });
});
