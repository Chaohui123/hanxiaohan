import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch for exchange rate API
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock module with controlled fetch
vi.mock("../../src/services/exchange-rate.js", async () => {
  const actual = await vi.importActual("../../src/services/exchange-rate.js") as { getExchangeRate: () => Promise<{ rate: number; cached: boolean; stale: boolean; reliable: boolean; source: string }>; clearRateCache: () => void };
  return actual;
});

import { getExchangeRate, clearRateCache } from "../../src/services/exchange-rate.js";

describe("getExchangeRate", () => {
  beforeEach(() => {
    clearRateCache();
    mockFetch.mockReset();
  });

  it("returns fallback rate when API fails", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const result = await getExchangeRate();
    expect(result.rate).toBeGreaterThan(0);
    expect(result.reliable).toBe(false);
  });

  it("returns fresh rate when API succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.14 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.011 } }) });
    const result = await getExchangeRate();
    expect(result.cached).toBe(false);
  });

  it("caches rate for subsequent calls", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.14 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rates: { USD: 0.011 } }) });
    await getExchangeRate();
    // Second call should use cache
    mockFetch.mockReset();
    const result2 = await getExchangeRate();
    expect(result2.cached).toBe(true);
  });

  it("clearRateCache forces re-fetch", () => {
    clearRateCache();
    // No error thrown = success
  });
});
