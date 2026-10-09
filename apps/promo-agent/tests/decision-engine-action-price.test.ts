// decision-engine 促销实付价口径 + 竞品威胁分过滤（2026-10 改造）：
// ① actionPriceRub > 0 时 currentPrice 用促销实付价，reason 标注「（含促销价口径）」
// ② 精准快照优先保留，其后套 threatWeightedAverage：<40 分不纳入，全被滤 → fallback 自己价格
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiConfig } from "../src/api-client.js";

// ---- Hoisted mock state ----
const mocks = vi.hoisted(() => ({
  products: vi.fn(),
  getPrices: vi.fn(),
}));

vi.mock("../src/api-client.js", () => ({
  promoApi: {
    exchangeRate: vi.fn().mockResolvedValue({ rate: 12 }),
    stores: vi.fn().mockResolvedValue({ items: [] }),
    orders: vi.fn().mockResolvedValue({ orders: [] }),
    products: mocks.products,
  },
  competitorApi: {
    getPrices: mocks.getPrices,
  },
}));

const config: ApiConfig = { apiBase: "http://localhost:3000", apiKey: "test-key" };

/** 基础商品：cost 30 CNY ×12 = 360₽，price 1000₽，库存/成本满足 eligible */
function baseItem(extra: Record<string, unknown> = {}) {
  return {
    offerId: "A1", name: "Test Product", price: 1000, stock: 10,
    cost: 30, weight: 0.2, rating: 4.0, ...extra,
  };
}

function comp(price: number, rating: number, salesCount: number, competitorUrl = "") {
  return { price, rating, salesCount, competitorUrl, capturedAt: "2026-10-05T00:00:00Z" };
}

beforeEach(() => {
  mocks.products.mockReset();
  mocks.getPrices.mockReset();
});

describe("scoreAllProducts — 促销实付价口径", () => {
  it("actionPriceRub > 0 时 currentPrice 用促销实付价，reason 标注", async () => {
    mocks.products.mockResolvedValue({ items: [baseItem({ actionPriceRub: 800 })] });
    mocks.getPrices.mockResolvedValue({ prices: [] });

    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);

    expect(scored).toHaveLength(1);
    expect(scored[0].currentPrice).toBe(800); // 不是 price 1000
    // 利润率按促销价口径：(800 − 360)/800 = 55%
    expect(scored[0].marginPercent).toBe(55);
    // 无竞品数据 → fallback 自己价格（促销价口径）
    expect(scored[0].competitorAvg).toBe(800);
    expect(scored[0].reason).toContain("（含促销价口径）");
  });

  it("actionPriceRub 为 0 或缺失时回退 price，reason 不标注", async () => {
    mocks.products.mockResolvedValue({
      items: [
        baseItem({ offerId: "A1", actionPriceRub: 0 }),
        baseItem({ offerId: "A2" }), // 无 actionPriceRub 字段
      ],
    });
    mocks.getPrices.mockResolvedValue({ prices: [] });

    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);

    expect(scored).toHaveLength(2);
    for (const p of scored) {
      expect(p.currentPrice).toBe(1000);
      expect(p.reason).not.toContain("（含促销价口径）");
    }
  });
});

describe("scoreAllProducts — 竞品威胁分过滤", () => {
  it("精准集内 <40 分被滤：competitorAvg 只剩高威胁竞品价（旧逻辑会被 3000₽ 低分拉偏到 2100₽）", async () => {
    mocks.products.mockResolvedValue({ items: [baseItem()] });
    mocks.getPrices.mockResolvedValue({
      prices: [
        comp(1200, 4.7, 150, "https://ozon.ru/a"), // 偏离0.2→16.7 + 30 + 20 ≈ 66.7 分
        comp(3000, 3.0, 0, "https://ozon.ru/b"),   // 带外 0 + 0 + 5 = 5 分 → 滤
      ],
    });

    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);

    expect(scored[0].competitorAvg).toBe(1200);
    // priceAdvantage = (1200−1000)/1200 = 16.7%
    expect(scored[0].priceAdvantage).toBeCloseTo(16.7, 1);
  });

  it("精准优先保留：精准 1 条 + 非精准 1 条 → 只用精准集", async () => {
    mocks.products.mockResolvedValue({ items: [baseItem()] });
    mocks.getPrices.mockResolvedValue({
      prices: [
        comp(1100, 4.6, 200, "https://ozon.ru/precise"), // 精准，≈83.3 分
        comp(900, 4.9, 999),                              // 非精准（不参与）
      ],
    });

    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);

    expect(scored[0].competitorAvg).toBe(1100);
  });

  it("精准集为空 → 回退全集同样套威胁过滤", async () => {
    mocks.products.mockResolvedValue({ items: [baseItem()] });
    mocks.getPrices.mockResolvedValue({
      prices: [
        comp(1100, 4.6, 200),  // ≈83.3 分
        comp(3000, 3.0, 0),    // 5 分 → 滤
      ],
    });

    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);

    expect(scored[0].competitorAvg).toBe(1100);
  });

  it("全被滤 → competitorAvg = fallback 自己价格（priceAdvantage=0，现状逻辑）", async () => {
    mocks.products.mockResolvedValue({ items: [baseItem()] });
    mocks.getPrices.mockResolvedValue({
      prices: [comp(3000, 2.0, 0)], // 带外 0 + 0 + 5 = 5 分 → 滤
    });

    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);

    expect(scored[0].competitorAvg).toBe(1000);
    expect(scored[0].priceAdvantage).toBe(0);
  });
});
