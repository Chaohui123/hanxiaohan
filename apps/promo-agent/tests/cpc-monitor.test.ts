import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const monitor = require("../../../temp/cpc-monitor-36145753.cjs") as {
  rollingRange(to: string): { from: string; to: string };
  apiResult(response: { status?: number; data?: unknown; error?: string }): {
    status: string; httpStatus: number | null; data: unknown; error?: string;
  };
  getCampaign(data: { list?: Array<Record<string, unknown>> }): Record<string, unknown> | null;
  dailyTotals(data: { rows?: Array<Record<string, unknown>> }): {
    totals: { shows: number; clicks: number; moneySpentRub: number; orders: number; ordersMoneyRub: number };
  };
  computeMonitor(out: Record<string, unknown>): unknown;
};

function successfulMonitor() {
  return {
    campaignId: "36145753",
    campaign: { status: "ok", data: { list: [] } },
    products: { status: "ok", data: [] },
    daily: { status: "ok", data: { rows: [] } },
    productStat: { status: "ok", data: "" },
    reportRequest: { status: "ok", data: { UUID: "report-id" } },
    report: { status: "ok", data: { state: "OK" } },
  };
}

describe("CPC 只读监控", () => {
  it("62 天区间含起止，超过一天才滚动起点", () => {
    expect(monitor.rollingRange("2026-10-18")).toEqual({ from: "2026-08-18", to: "2026-10-18" });
    expect(monitor.rollingRange("2026-10-19")).toEqual({ from: "2026-08-19", to: "2026-10-19" });
  });

  it("HTTP 400 和网络失败均标记 error，且 computed=null", () => {
    const badRequest = monitor.apiResult({ status: 400, data: { error: "bad request" } });
    expect(badRequest.status).toBe("error");
    expect(badRequest.httpStatus).toBe(400);
    expect(monitor.apiResult({ error: "socket closed" }).status).toBe("error");

    const out = successfulMonitor();
    out.daily = { status: "error", data: null };
    expect(monitor.computeMonitor(out)).toBeNull();
  });

  it("campaign 查询保留 INACTIVE，而不是误判不存在", () => {
    expect(monitor.getCampaign({ list: [{ id: 36145753, state: "CAMPAIGN_STATE_INACTIVE" }] }))
      .toMatchObject({ state: "CAMPAIGN_STATE_INACTIVE" });
  });

  it("成功但没有数据时保留真实 0", () => {
    expect(monitor.dailyTotals({ rows: [] }).totals).toEqual({
      shows: 0, clicks: 0, moneySpentRub: 0, orders: 0, ordersMoneyRub: 0,
    });
    expect(monitor.computeMonitor(successfulMonitor())).toMatchObject({
      totals: { shows: 0, clicks: 0, moneySpentRub: 0, orders: 0, ordersMoneyRub: 0 },
    });
  });
});
