import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "../src/api-client.js";
import type { PlannedAction } from "../src/decision-engine.js";
import type { ProductScore } from "../src/scorer.js";
import { applyAstraGuard, emptyAstraState } from "../src/astra-guard.js";

const mocks = vi.hoisted(() => ({
  fx: vi.fn(), orders: vi.fn(), products: vi.fn(), getPrices: vi.fn(),
}));

vi.mock("../src/api-client.js", () => ({
  promoApi: {
    exchangeRate: mocks.fx,
    stores: vi.fn().mockResolvedValue({ items: [] }),
    orders: mocks.orders,
    products: mocks.products,
  },
  competitorApi: { getPrices: mocks.getPrices },
}));

const config: ApiConfig = { apiBase: "http://localhost:3000", apiKey: "test" };

function product(extra: Partial<ProductScore> = {}): ProductScore {
  const synced = extra.competitorAvg !== undefined && extra.pricingCompetitorAvg === undefined && extra.hasFreshPreciseCompetitor
    ? { ...extra, pricingCompetitorAvg: extra.competitorAvg }
    : extra;
  return {
    offerId: "P1", name: "Product", cost: 10, costRub: 500,
    logisticsRub: 65.64, packagingRub: 60, fixedCostRub: 625.64, unitProfitRub: 400,
    weightG: 100, exchangeRate: 12,
    pricingBlockers: [], hasFreshPreciseCompetitor: false, latestPreciseCapturedAt: null,
    pricingCompetitorAvg: null, pricingCompetitorCapturedAt: null,
    currentPrice: 1500, stock: 20, marginPercent: 30, competitorAvg: 1400,
    priceAdvantage: -10, salesGrowth7d: 0, rating: 4.5, totalScore: 70, floorPrice: 1000,
    breakdown: { margin: 80, priceAdvantage: 30, stock: 80, salesGrowth: 0, rating: 100 },
    recommendation: "pricing", reason: "test", ...synced,
  };
}

function action(extra: Partial<PlannedAction> = {}): PlannedAction {
  return {
    offerId: "P1", name: "Product", type: "pricing", suggestedPrice: 1400,
    currentPrice: 1500, priority: 1, reason: "test", priceReason: "competitor_drop", ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fx.mockResolvedValue({ rate: 12 });
  mocks.orders.mockResolvedValue({ data: [] });
  mocks.products.mockResolvedValue({ items: [{ offerId: "P1", name: "Product", price: 1500, stock: 20, cost: 5, weight: 0.1, rating: 4.5 }] });
  mocks.getPrices.mockResolvedValue({ prices: [] });
});

describe("scoreAllProducts 数据失败硬闸门", () => {
  it.each([
    ["fx", "FX_UNAVAILABLE"],
    ["orders", "ORDERS_UNAVAILABLE"],
  ] as const)("%s 失败显式记录 blocker", async (source, blocker) => {
    mocks[source].mockRejectedValue(new Error("unavailable"));
    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);
    expect(scored).toHaveLength(1);
    expect(scored[0].pricingBlockers).toContain(blocker);
    if (source === "fx") expect(scored[0].costRub).toBe(0);
  });

  it("订单响应畸形同样阻断，不当成零订单", async () => {
    mocks.orders.mockResolvedValue({ success: false, error: "sync failed" });
    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);
    expect(scored[0].pricingBlockers).toContain("ORDERS_UNAVAILABLE");
  });

  it.each([
    [{ orders: "malformed", data: [] }],
    [{ orders: null, data: [] }],
    [{ orders: undefined, data: [] }],
    [{}],
  ])("orders/data 畸形组合只消费验证数组并阻断: %j", async (payload) => {
    mocks.orders.mockResolvedValue(payload);
    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);
    expect(scored[0].pricingBlockers).toContain("ORDERS_UNAVAILABLE");
    expect(scored[0].salesGrowth7d).toBe(0);
  });

  it.each([
    [{ orders: [], data: "ignored malformed data" }],
    [{ orders: [] }],
    [{ data: [] }],
  ])("orders/data 有效组合不阻断: %j", async (payload) => {
    mocks.orders.mockResolvedValue(payload);
    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);
    expect(scored[0].pricingBlockers).not.toContain("ORDERS_UNAVAILABLE");
  });

  it("orders 与 data 同存且均有效时只消费 orders", async () => {
    mocks.orders.mockResolvedValue({
      orders: [{ createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString(), products_json: '[{"offerId":"P1"}]' }],
      data: [{ createdAt: new Date().toISOString(), products_json: '[{"offerId":"P1"}]' }],
    });
    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);
    expect(scored[0].pricingBlockers).not.toContain("ORDERS_UNAVAILABLE");
    expect(scored[0].salesGrowth7d).toBe(-100);
  });

  it("缺重量保留商品、warn 可追踪且 planActions 不产生价格动作", async () => {
    mocks.products.mockResolvedValue({ items: [{ offerId: "P1", price: 1500, stock: 20, cost: 5, weight: 0 }] });
    const { scoreAllProducts, planActions } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);
    expect(scored[0].pricingBlockers).toContain("MISSING_WEIGHT");
    expect(Number.isFinite(scored[0].fixedCostRub)).toBe(true);
    expect(planActions(scored)).toHaveLength(0);
  });
});

describe("24h 精准竞品硬闸门", () => {
  it.each([
    ["过期精准", "https://ozon.ru/precise", 25],
    ["仅聚合", "", 1],
  ])("%s 禁止向下调价", async (_name, competitorUrl, ageHours) => {
    mocks.getPrices.mockResolvedValue({ prices: [{
      price: 1300, rating: 4.8, salesCount: 100, competitorUrl,
      capturedAt: new Date(Date.now() - ageHours * 3600_000).toISOString(),
    }] });
    const { scoreAllProducts, planActions } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);
    expect(scored[0].hasFreshPreciseCompetitor).toBe(false);
    expect(scored[0].priceAdvantage).toBeLessThan(-5);
    expect(planActions(scored)).toHaveLength(0);
  });

  it("QC反例：新鲜100₽零威胁不能解锁25h前1800₽高威胁涨价", async () => {
    mocks.getPrices.mockResolvedValue({ prices: [
      { price: 100, rating: 0, salesCount: 0, competitorUrl: "https://ozon.ru/fresh-low", capturedAt: new Date().toISOString() },
      { price: 1800, rating: 4.8, salesCount: 100, competitorUrl: "https://ozon.ru/stale-high", capturedAt: new Date(Date.now() - 25 * 3600_000).toISOString() },
    ] });
    const { scoreAllProducts, planActions } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);
    expect(scored[0].competitorAvg).toBe(1800);
    expect(scored[0].pricingCompetitorAvg).toBeNull();
    expect(scored[0].hasFreshPreciseCompetitor).toBe(false);
    expect(planActions(scored)).toHaveLength(0);
  });

  it("24h 内精准快照允许进入向下调价规划", async () => {
    mocks.getPrices.mockResolvedValue({ prices: [{
      price: 1300, rating: 4.8, salesCount: 100, competitorUrl: "https://ozon.ru/precise",
      capturedAt: new Date(Date.now() - 3600_000).toISOString(),
    }] });
    const { scoreAllProducts, planActions } = await import("../src/decision-engine.js");
    const actions = planActions(await scoreAllProducts(config));
    expect(actions).toHaveLength(1);
    expect(actions[0].suggestedPrice!).toBeLessThan(actions[0].currentPrice);
  });

  it("基于竞品优势的涨价也要求新鲜精准快照", async () => {
    const { planActions } = await import("../src/decision-engine.js");
    const stale = product({ competitorAvg: 2000, priceAdvantage: 20 });
    expect(planActions([stale])).toHaveLength(0);
    const fresh = product({ competitorAvg: 2000, priceAdvantage: 20, hasFreshPreciseCompetitor: true });
    expect(planActions([fresh])[0].suggestedPrice).toBe(1575);
  });

  it("纯利润修复涨价不依赖竞品，缺成本仍被阻断", async () => {
    const { planActions } = await import("../src/decision-engine.js");
    const repair = product({ marginPercent: 10, priceAdvantage: 0, competitorAvg: 1500 });
    const actions = planActions([repair]);
    expect(actions).toHaveLength(1);
    expect(actions[0].priceReason).toBe("profit_repair");
    expect(actions[0].suggestedPrice!).toBeGreaterThan(1500);
    expect(planActions([product({ ...repair, pricingBlockers: ["MISSING_COST"] })])).toHaveLength(0);
  });

  it("低总分负利润也生成向上 profit_repair，普通 copy 仍跳过", async () => {
    const { planActions } = await import("../src/decision-engine.js");
    const negative = product({ totalScore: 20, marginPercent: -5, floorPrice: 1600 });
    const actions = planActions([negative]);
    expect(actions).toHaveLength(1);
    expect(actions[0].priceReason).toBe("profit_repair");
    expect(actions[0].suggestedPrice!).toBeGreaterThan(1500);
    expect(Number.isFinite(actions[0].suggestedPrice)).toBe(true);
    expect(planActions([product({ totalScore: 20, recommendation: "copy" })])).toHaveLength(0);
  });

  it("current<floor 时向上利润修复允许 10% 中间步骤", async () => {
    const { planActions } = await import("../src/decision-engine.js");
    const repair = product({ currentPrice: 772.77, floorPrice: 917.97, marginPercent: -5 });
    const actions = planActions([repair]);
    expect(actions).toHaveLength(1);
    expect(actions[0].priceReason).toBe("profit_repair");
    expect(actions[0].suggestedPrice).toBe(850);
    expect(actions[0].suggestedPrice!).toBeGreaterThan(772.77);
    expect(actions[0].suggestedPrice!).toBeLessThan(917.97);
  });

  it("19.96% 原始利润率仍触发利润修复且建议价有限", async () => {
    const { planActions } = await import("../src/decision-engine.js");
    const actions = planActions([product({ marginPercent: 19.96, priceAdvantage: 0, competitorAvg: 1500 })]);
    expect(actions).toHaveLength(1);
    expect(actions[0].priceReason).toBe("profit_repair");
    expect(Number.isFinite(actions[0].suggestedPrice)).toBe(true);
    expect(actions[0].suggestedPrice!).toBeGreaterThan(1500);
  });

  it("不一致夹具：profit_repair 目标不高于现价时不得借新鲜竞品降价", async () => {
    const { planActions } = await import("../src/decision-engine.js");
    const inconsistent = product({
      marginPercent: 19.96, floorPrice: 1000, costRub: 0, packagingRub: 0, fixedCostRub: 0,
      competitorAvg: 1300, pricingCompetitorAvg: 1300, hasFreshPreciseCompetitor: true,
    });
    expect(planActions([inconsistent])).toHaveLength(0);
    const copy = planActions([product({ ...inconsistent, recommendation: "copy_and_pricing" })]);
    expect(copy).toHaveLength(1);
    expect(copy[0].type).toBe("copy");
    expect(copy[0].suggestedPrice).toBeUndefined();
  });

  it("纯文案不受竞品闸门，组合动作只剥离 pricing", async () => {
    const { planActions } = await import("../src/decision-engine.js");
    expect(planActions([product({ recommendation: "copy" })])).toHaveLength(1);
    const combined = planActions([product({ recommendation: "copy_and_pricing" })]);
    expect(combined).toHaveLength(1);
    expect(combined[0].type).toBe("copy");
    expect(combined[0].suggestedPrice).toBeUndefined();
  });
});

describe("applyAstraGuard 最终执行前硬闸门", () => {
  const ctx = () => ({
    sales14d: () => ({ recent: 1, prev: 1 }), isAdjustedToday: () => false,
    greenOffers: new Set<string>(), state: emptyAstraState(),
  });

  it("即使绕过 planActions，缺重量和过期竞品也不能进入最终动作", () => {
    expect(applyAstraGuard([action({ suggestedPrice: 1600, priceReason: "profit_repair" })], [product({ pricingBlockers: ["MISSING_WEIGHT"] })], ctx())).toHaveLength(0);
    expect(applyAstraGuard([action()], [product()], ctx())).toHaveLength(0);
  });

  it("astra 放行向上修复中间价，仍拒绝向下穿 floor", () => {
    const repair = product({ currentPrice: 772.77, floorPrice: 917.97, marginPercent: -5 });
    const upward = action({ currentPrice: 772.77, suggestedPrice: 850, priceReason: "profit_repair" });
    expect(applyAstraGuard([upward], [repair], ctx())).toHaveLength(1);
    const downwardProduct = product({ currentPrice: 772.77, floorPrice: 917.97, competitorAvg: 700, pricingCompetitorAvg: 700, hasFreshPreciseCompetitor: true });
    const downward = action({ currentPrice: 772.77, suggestedPrice: 700, priceReason: "competitor_drop" });
    expect(applyAstraGuard([downward], [downwardProduct], ctx())).toHaveLength(0);
  });

  it("新鲜布尔也不能让过期展示均价驱动 astra 涨价", () => {
    const stale = product({ competitorAvg: 1800, pricingCompetitorAvg: null, hasFreshPreciseCompetitor: true });
    const out = applyAstraGuard([action({ suggestedPrice: 1575, priceReason: "competitor_raise" })], [stale], ctx());
    expect(out).toHaveLength(0);
  });

  it("astra 同样拒绝 profit_repair 向下动作并保留组合文案", () => {
    const p = product({ pricingCompetitorAvg: 1300, hasFreshPreciseCompetitor: true });
    expect(applyAstraGuard([action({ suggestedPrice: 1400, priceReason: "profit_repair" })], [p], ctx())).toHaveLength(0);
    const combined = applyAstraGuard([action({ type: "copy_and_pricing", suggestedPrice: 1400, priceReason: "profit_repair" })], [p], ctx());
    expect(combined).toHaveLength(1);
    expect(combined[0].type).toBe("copy");
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])("无有限建议价的 pricing 最终不得执行: %s", (suggestedPrice) => {
    expect(applyAstraGuard([action({ suggestedPrice, priceReason: "profit_repair" })], [product()], ctx())).toHaveLength(0);
    const combined = applyAstraGuard([action({ type: "copy_and_pricing", suggestedPrice })], [product()], ctx());
    expect(combined).toHaveLength(1);
    expect(combined[0].type).toBe("copy");
  });

  it("组合动作保留 copy，纯 copy 原样直通", () => {
    const combined = applyAstraGuard([action({ type: "copy_and_pricing" })], [product()], ctx());
    expect(combined).toHaveLength(1);
    expect(combined[0].type).toBe("copy");
    expect(combined[0].suggestedPrice).toBeUndefined();
    const copy = applyAstraGuard([action({ type: "copy", suggestedPrice: undefined })], [product()], ctx());
    expect(copy).toHaveLength(1);
  });
});
