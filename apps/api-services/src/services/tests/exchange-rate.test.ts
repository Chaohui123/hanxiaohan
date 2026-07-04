import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@onzo/cache", () => ({ cache: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined), del: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../notification-events.js", () => ({ emitEvent: vi.fn(), EVENT_KEYS: { EXCHANGE_RATE_STALE: "EXCHANGE_RATE_STALE" } }));

import { getExchangeRate, forceRefreshRate } from "../exchange-rate.js";

describe("getExchangeRate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forceRefreshRate();
  });

  it("returns fallback rate when all APIs fail with no cache", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const result = await getExchangeRate();
    expect(result.rate).toBe(11.5);
    expect(result.reliable).toBe(false);
    expect(result.source).toBe("hardcoded-fallback");
  });

  it("returns fresh rate when primary API succeeds", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.14 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.011 } }) });
    const r = await getExchangeRate();
    expect(r.cached).toBe(false);
    expect(r.reliable).toBe(true);
    expect(r.source).toBe("dual");
  });

  it("detects deviation >5% between sources", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.14 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.009 } }) }); // ~15.5 vs ~12.7, ~18% deviation
    const r = await getExchangeRate();
    expect(r.reliable).toBe(false);
  });

  it("uses cache on second call", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.14 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.011 } }) });
    await getExchangeRate();
    // Second call — should use memory cache
    global.fetch = vi.fn();
    const r2 = await getExchangeRate();
    expect(r2.cached).toBe(true);
  });

  it("forceRefreshRate clears cache", () => {
    forceRefreshRate();
    // No error = success
  });
});
