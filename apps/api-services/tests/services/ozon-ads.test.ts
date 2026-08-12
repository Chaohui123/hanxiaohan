// ozon-ads — Ozon Performance API 客户端测试（mock fetch）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAdDailyStats, resetAdTokenCache } from "../../src/services/ozon-ads.js";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe("ozon-ads getAdDailyStats", () => {
  beforeEach(() => {
    resetAdTokenCache();
    vi.stubEnv("OZON_PERF_CLIENT_ID", "test-client");
    vi.stubEnv("OZON_PERF_CLIENT_SECRET", "test-secret");
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns null when credentials are not configured", async () => {
    delete process.env.OZON_PERF_CLIENT_ID;
    delete process.env.OZON_PERF_CLIENT_SECRET;
    const r = await getAdDailyStats("2026-08-01", "2026-08-07");
    expect(r).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("aggregates daily rows including locale-formatted numbers", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1" }))
      .mockResolvedValueOnce(jsonResponse({
        rows: [
          { views: "1 000", clicks: "50", moneySpent: "1 234,56", orders: "2", ordersMoney: "3 000" },
          { views: 500, clicks: 25, moneySpent: 765.44, orders: 1, ordersMoney: 1500 },
        ],
      }));
    const r = await getAdDailyStats("2026-08-01", "2026-08-07");
    expect(r).not.toBeNull();
    expect(r!.spendRub).toBeCloseTo(2000, 2);
    expect(r!.shows).toBe(1500);
    expect(r!.clicks).toBe(75);
    expect(r!.adOrders).toBe(3);
    expect(r!.adRevenueRub).toBe(4500);
  });

  it("reuses cached token across calls", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1" }))
      .mockResolvedValue(jsonResponse({ rows: [] }));
    global.fetch = f;
    await getAdDailyStats("2026-08-01", "2026-08-07");
    await getAdDailyStats("2026-08-08", "2026-08-14");
    expect(f).toHaveBeenCalledTimes(3); // 1 token + 2 stats
    const tokenCalls = f.mock.calls.filter((c) => String(c[0]).includes("/api/client/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("returns null when token request fails", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({}, false, 401));
    expect(await getAdDailyStats("2026-08-01", "2026-08-07")).toBeNull();
  });

  it("returns null when stats request fails", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1" }))
      .mockRejectedValueOnce(new Error("timeout"));
    expect(await getAdDailyStats("2026-08-01", "2026-08-07")).toBeNull();
  });
});
