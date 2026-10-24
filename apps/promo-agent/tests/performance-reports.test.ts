import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuBot } from "@onzo/feishu-bot";
import type { ApiConfig } from "../src/api-client.js";

const mocks = vi.hoisted(() => ({
  daily: vi.fn(),
  weekly: vi.fn(),
  pricingHistory: vi.fn(),
  copyHistory: vi.fn(),
  promoCost: vi.fn(),
  orders: vi.fn(),
  updateProduct: vi.fn(),
  sendMessage: vi.fn(),
  queryRag: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../src/api-client.js", () => ({
  promoApi: { orders: mocks.orders, updateProduct: mocks.updateProduct },
  statsApi: {
    daily: mocks.daily,
    weekly: mocks.weekly,
    pricingHistory: mocks.pricingHistory,
    copyHistory: mocks.copyHistory,
    promoCost: mocks.promoCost,
  },
}));

vi.mock("@onzo/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: mocks.warn },
}));

vi.mock("@onzo/embedding", () => ({
  queryRag: mocks.queryRag,
  extractRagContent: vi.fn(),
}));

import {
  checkAndSend,
  extractOrderList,
  runEffectRetrospective,
  sendDailyReport,
  sendWeeklyReport,
  startPerformanceReports,
  stopPerformanceReports,
} from "../src/performance.js";

const config: ApiConfig = { apiBase: "http://localhost:3000", apiKey: "test-key" };
const bot = { sendMessage: mocks.sendMessage } as unknown as FeishuBot;
const emptyDaily = { orders: 0, revenue: 0, avgOrderValue: 0, cancelledOrders: 0, topProducts: [] };
const emptyWeekly = { orders: 0, revenue: 0, byDay: [], top5: [], bottom5: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.daily.mockResolvedValue(emptyDaily);
  mocks.weekly.mockResolvedValue(emptyWeekly);
  mocks.pricingHistory.mockResolvedValue({ adjustments: [] });
  mocks.copyHistory.mockResolvedValue({ copies: [] });
  mocks.promoCost.mockResolvedValue({ adSpend: 0, totalRevenue: 0, organicRevenue: 0, paidRevenue: 0, roi: null });
  mocks.orders.mockResolvedValue({ data: [] });
  mocks.updateProduct.mockResolvedValue({ success: true });
  mocks.sendMessage.mockResolvedValue(true);
  mocks.queryRag.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("日报/周报数据源失败", () => {
  it("日报各数据源失败显示未知，不伪装成 0", async () => {
    mocks.daily.mockRejectedValueOnce(new Error("daily unavailable"));
    mocks.pricingHistory.mockRejectedValueOnce(new Error("pricing unavailable"));
    mocks.copyHistory.mockRejectedValueOnce(new Error("copy unavailable"));
    mocks.promoCost.mockRejectedValueOnce(new Error("ads unavailable"));

    await expect(sendDailyReport(bot, "chat-id", config)).resolves.toBe(true);
    const message = mocks.sendMessage.mock.calls[0][1] as string;
    expect(message).toContain("订单: **未知/同步失败**");
    expect(message).toContain("销售额: **未知/同步失败**");
    expect(message).toContain("广告花费: 未知/同步失败");
    expect(message).toContain("调价: 未知/同步失败");
    expect(message).toContain("文案优化: 未知/同步失败");
    expect(message).not.toContain("订单: **0**");
  });

  it("周报订单、广告、调价和文案失败分别显示未知", async () => {
    mocks.weekly.mockRejectedValueOnce(new Error("weekly unavailable"));
    mocks.pricingHistory.mockRejectedValueOnce(new Error("pricing unavailable"));
    mocks.copyHistory.mockRejectedValueOnce(new Error("copy unavailable"));
    mocks.promoCost.mockRejectedValueOnce(new Error("ads unavailable"));

    await expect(sendWeeklyReport(bot, "chat-id", config)).resolves.toBe(true);
    const message = mocks.sendMessage.mock.calls[0][1] as string;
    expect(message).toContain("总订单: **未知/同步失败**");
    expect(message).toContain("总销售额: **未知/同步失败**");
    expect(message).toContain("广告花费: 未知/同步失败");
    expect(message).toContain("调价次数: 未知/同步失败");
    expect(message).toContain("文案优化: 未知/同步失败");
    expect(message).toContain("调价效果: 未知/同步失败");
  });
});

describe("报告发送防重与重试", () => {
  it("日报 sendMessage=false 下一分钟重试，true 后不再重复", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 25, 9, 0));
    mocks.sendMessage.mockResolvedValueOnce(false);

    await checkAndSend(bot, "chat-id", config);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(2026, 9, 25, 9, 1));
    await checkAndSend(bot, "chat-id", config);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date(2026, 9, 25, 9, 2));
    await checkAndSend(bot, "chat-id", config);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("周报 sendMessage=false 也可重试且 true 后防重", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 26, 9, 0));
    await checkAndSend(bot, "chat-id", config);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(2026, 9, 26, 9, 1));
    mocks.sendMessage.mockResolvedValueOnce(false);
    await checkAndSend(bot, "chat-id", config);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date(2026, 9, 26, 9, 2));
    await checkAndSend(bot, "chat-id", config);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(3);

    vi.setSystemTime(new Date(2026, 9, 26, 9, 3));
    await checkAndSend(bot, "chat-id", config);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(3);
  });
});

describe("报告调度执行中锁", () => {
  it("前一轮超过 60 秒时跳过后续 tick，不重复生成或发送", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 1, 9, 0));
    let finishSend: ((sent: boolean) => void) | undefined;
    mocks.sendMessage.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishSend = resolve;
    }));
    startPerformanceReports(bot, "chat-id", config);

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.daily).toHaveBeenCalledTimes(2);
      expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(180_000);
      expect(mocks.daily).toHaveBeenCalledTimes(2);
      expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      stopPerformanceReports();
      finishSend?.(true);
      await vi.advanceTimersByTimeAsync(0);
    }
  });
});

describe("效果回溯订单契约", () => {
  it("兼容 data 数组并只 mock 更新回溯结果", async () => {
    const appliedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    mocks.pricingHistory.mockResolvedValue({
      adjustments: [{ offerId: "A1", name: "A1", appliedAt, salesAfter: 0 }],
    });
    mocks.orders.mockResolvedValue({
      success: true,
      data: [{ createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), items: [{ offerId: "A1" }] }],
    });

    await runEffectRetrospective(config);

    expect(mocks.updateProduct).toHaveBeenCalledTimes(1);
    expect(mocks.updateProduct).toHaveBeenCalledWith(config, "A1", expect.objectContaining({ salesAfter7d: 1 }));
    expect(extractOrderList({ orders: [] })).toEqual([]);
    expect(extractOrderList({ data: [] })).toEqual([]);
  });

  it("正常 products_json 数组参与效果回溯", async () => {
    const appliedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    mocks.pricingHistory.mockResolvedValue({
      adjustments: [{ offerId: "A1", name: "A1", appliedAt, salesAfter: 0 }],
    });
    mocks.orders.mockResolvedValue({
      data: [{
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        products_json: JSON.stringify([{ offerId: "A1", quantity: 1 }]),
      }],
    });

    await runEffectRetrospective(config);

    expect(mocks.updateProduct).toHaveBeenCalledWith(config, "A1", expect.objectContaining({ salesAfter7d: 1 }));
  });

  it("products_json 畸形 JSON 记 warn 且不更新", async () => {
    const appliedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    mocks.pricingHistory.mockResolvedValue({
      adjustments: [{ offerId: "A1", name: "A1", appliedAt, salesAfter: 0 }],
    });
    mocks.orders.mockResolvedValue({
      data: [{
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        products_json: "{not-json",
      }],
    });

    await runEffectRetrospective(config);

    expect(mocks.warn).toHaveBeenCalledWith(
      { offerId: "A1" },
      "Malformed order items skipped during retrospective",
    );
    expect(mocks.updateProduct).not.toHaveBeenCalled();
  });

  it("订单接口失败或响应畸形记 warn，不按 0 订单更新", async () => {
    const appliedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    mocks.pricingHistory.mockResolvedValue({
      adjustments: [{ offerId: "A1", name: "A1", appliedAt, salesAfter: 0 }],
    });
    mocks.orders.mockResolvedValueOnce({ success: true, data: { invalid: true } });
    await runEffectRetrospective(config);
    expect(mocks.warn).toHaveBeenCalledWith(
      { offerId: "A1" },
      "Orders API returned no valid orders/data array; retrospective skipped",
    );

    mocks.orders.mockRejectedValueOnce(new Error("orders unavailable"));
    await runEffectRetrospective(config);
    expect(mocks.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), offerId: "A1" },
      "Orders API failed; retrospective skipped",
    );
    expect(mocks.updateProduct).not.toHaveBeenCalled();
  });
});
