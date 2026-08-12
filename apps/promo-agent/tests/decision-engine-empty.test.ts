// 空评分抑制空卡片 — runDecisionCycle 在 scoreAllProducts 返回空数组时直接返回，不发飞书卡片
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FeishuBot } from "@onzo/feishu-bot";
import type { ApiConfig } from "../src/api-client.js";

vi.mock("../src/api-client.js", () => ({
  promoApi: {
    exchangeRate: vi.fn().mockResolvedValue({ rate: 12 }),
    stores: vi.fn().mockResolvedValue({ items: [] }),
    orders: vi.fn().mockResolvedValue({ orders: [] }),
    products: vi.fn().mockResolvedValue({ items: [] }),
  },
  competitorApi: {
    getPrices: vi.fn().mockResolvedValue({ prices: [] }),
  },
}));

const config: ApiConfig = { apiBase: "http://localhost:3000", apiKey: "test-key" };

describe("runDecisionCycle — 空评分抑制", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("商品数据源为空时 scoreAllProducts 返回空数组", async () => {
    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);
    expect(scored).toEqual([]);
  });

  it("评分结果为空时不发送飞书卡片", async () => {
    const { runDecisionCycle, setAutoDecisionEnabled } = await import("../src/decision-engine.js");
    setAutoDecisionEnabled(true);

    const bot = { sendPromoCard: vi.fn().mockResolvedValue(undefined) } as unknown as FeishuBot;
    await runDecisionCycle(bot, "chat-1", config);

    expect(bot.sendPromoCard).not.toHaveBeenCalled();
  });
});
