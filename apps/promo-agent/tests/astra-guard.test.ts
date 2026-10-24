// astra 校验层（GPT astra 定价方案）五条款测试：
// 条款1 零单不降价 / 条款2 有优势不降价 / 条款3 g_BE 盈亏平衡 / 条款4 RED 分级 / 条款5 止损回退
import { describe, it, expect } from "vitest";
import {
  applyAstraGuard, recordAstraTrial, emptyAstraState,
  type AstraGuardContext, type AstraState,
} from "../src/astra-guard.js";
import type { PlannedAction } from "../src/decision-engine.js";
import type { ProductScore } from "../src/scorer.js";
import { oglFixedCostRub, unitEconomicsConfigFromEnv, unitProfitRub } from "../src/unit-economics.js";

// ---- 测试夹具 ----

function baseProduct(extra: Partial<ProductScore> = {}): ProductScore {
  const synced = extra.competitorAvg !== undefined && extra.pricingCompetitorAvg === undefined
    ? { ...extra, pricingCompetitorAvg: extra.competitorAvg }
    : extra;
  return {
    offerId: "P1",
    name: "Test Product",
    cost: 50,
    costRub: 50,
    logisticsRub: 40,
    packagingRub: 10,
    fixedCostRub: 100,
    unitProfitRub: 406.7,
    weightG: 44.534,
    exchangeRate: 10,
    pricingBlockers: [],
    hasFreshPreciseCompetitor: true,
    latestPreciseCapturedAt: new Date().toISOString(),
    pricingCompetitorAvg: 1000,
    pricingCompetitorCapturedAt: new Date().toISOString(),
    currentPrice: 1000,
    stock: 50,
    marginPercent: 50,
    competitorAvg: 1000,
    priceAdvantage: 0,
    salesGrowth7d: 0,
    rating: 4.0,
    totalScore: 60,
    floorPrice: 700,
    breakdown: { margin: 80, priceAdvantage: 50, stock: 80, salesGrowth: 0, rating: 60 },
    recommendation: "pricing",
    reason: "test",
    ...synced,
  };
}

/** 向下调价 action（cur=1000 → 990） */
function dropAction(extra: Partial<PlannedAction> = {}): PlannedAction {
  return {
    offerId: "P1",
    name: "Test Product",
    type: "pricing",
    suggestedPrice: 990,
    currentPrice: 1000,
    priority: 1,
    reason: "价格高于竞品均价，不利可降价",
    ...extra,
  };
}

function makeCtx(extra: Partial<AstraGuardContext> & { state?: AstraState } = {}): AstraGuardContext {
  return {
    sales14d: () => ({ recent: 2, prev: 1 }), // 默认有单
    isAdjustedToday: () => false,
    greenOffers: new Set<string>(),
    state: emptyAstraState(),
    ...extra,
  };
}

// ============================================================
// 直通场景：copy / 涨价动作不受 astra 约束
// ============================================================

describe("astra-guard — 直通", () => {
  it("copy 动作直通（suggestedPrice 缺失）", () => {
    const action: PlannedAction = { ...dropAction(), type: "copy", suggestedPrice: undefined };
    const out = applyAstraGuard([action], [baseProduct()], makeCtx());
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("copy");
  });

  it("涨价动作（利润修复/优势涨价）直通，不进 g_BE 校验", () => {
    const action = dropAction({ suggestedPrice: 1050 }); // 涨价
    const out = applyAstraGuard([action], [baseProduct()], makeCtx());
    expect(out).toHaveLength(1);
    expect(out[0].suggestedPrice).toBe(1050);
  });

  it("无评分数据的 pricing action 硬阻断", () => {
    const out = applyAstraGuard([dropAction({ offerId: "UNKNOWN" })], [baseProduct()], makeCtx());
    expect(out).toHaveLength(0);
  });
});

// ============================================================
// 条款1 零单识别（防"66T 降到死"）
// ============================================================

describe("astra-guard — 条款1 零单不降价", () => {
  const zeroSales = () => ({ recent: 0, prev: 0 });

  it("连续2周期零单且已降价2次 → 剔除（需求止损）", () => {
    const state = emptyAstraState();
    state.zeroCycles.P1 = 1; // 上轮已零单，本轮再零单 → 累计 2
    state.trials.P1 = { preTrialPrice: 1100, startedAt: new Date().toISOString(), drops: 2 };
    const out = applyAstraGuard(
      [dropAction()], [baseProduct()],
      makeCtx({ sales14d: zeroSales, state }),
    );
    expect(out).toHaveLength(0);
    expect(state.zeroCycles.P1).toBe(2);
  });

  it("零单但未降价过（drops<2）→ 不触发条款1", () => {
    const state = emptyAstraState();
    state.zeroCycles.P1 = 3;
    const out = applyAstraGuard(
      [dropAction()], [baseProduct()],
      makeCtx({ sales14d: zeroSales, state, greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(1); // 条款3 GREEN 小降幅可放行
  });

  it("零单周期不足 N（首轮零单）→ 不触发条款1", () => {
    const state = emptyAstraState();
    state.trials.P1 = { preTrialPrice: 1100, startedAt: new Date().toISOString(), drops: 3 };
    const out = applyAstraGuard(
      [dropAction()], [baseProduct()],
      makeCtx({ sales14d: zeroSales, state, greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(1);
    expect(state.zeroCycles.P1).toBe(1);
  });

  it("出单后零单周期计数清零", () => {
    const state = emptyAstraState();
    state.zeroCycles.P1 = 5;
    applyAstraGuard([dropAction()], [baseProduct()], makeCtx({ state }));
    expect(state.zeroCycles.P1).toBe(0);
  });

  it("copy_and_pricing 被剔 pricing 时降级为 copy（文案部分不陪葬）", () => {
    const state = emptyAstraState();
    state.zeroCycles.P1 = 2;
    state.trials.P1 = { preTrialPrice: 1100, startedAt: new Date().toISOString(), drops: 2 };
    const action = dropAction({ type: "copy_and_pricing" });
    const out = applyAstraGuard(
      [action], [baseProduct()],
      makeCtx({ sales14d: () => ({ recent: 0, prev: 0 }), state }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("copy");
    expect(out[0].suggestedPrice).toBeUndefined();
    expect(out[0].reason).toContain("零单不降价");
  });
});

// ============================================================
// 条款2 有优势不降价（防"61N 白降"）
// ============================================================

describe("astra-guard — 条款2 有优势不降价", () => {
  it("现价 ≤ 竞品均价×0.98 → 剔除（价格本有优势，再降白亏利润）", () => {
    // cur=1000 ≤ 1030×0.98=1009.4
    const out = applyAstraGuard(
      [dropAction()], [baseProduct({ competitorAvg: 1030 })],
      makeCtx({ greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(0);
  });

  it("现价 > 竞品均价×0.98 → 条款2 放行，进入后续校验", () => {
    // cur=1000 > 1000×0.98=980；d=(1000-970)/1000=3% → 条款4 优先试点；GREEN g_BE=1.031≤1.075 放行
    const out = applyAstraGuard(
      [dropAction()], [baseProduct({ competitorAvg: 1000 })],
      makeCtx({ greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(1);
  });
});

// ============================================================
// 条款4 RED 分级
// ============================================================

describe("astra-guard — 条款4 RED 分级", () => {
  it("翻绿降幅 ≤3% → 优先试点（标记 high，排最前）", () => {
    // P1: cur=1000, compAvg=1000 → d=3% → 试点标记 priority=0 排最前
    // P2: cur=1010, compAvg=1000 → d≈3.96% → 3-5% 分两步（不标 high），降一半至 990
    const p2Action = dropAction({ offerId: "P2", suggestedPrice: 970, currentPrice: 1010 });
    const p2 = baseProduct({ offerId: "P2", currentPrice: 1010, competitorAvg: 1000 });
    const out = applyAstraGuard(
      [dropAction(), p2Action],
      [baseProduct(), p2],
      makeCtx({ greenOffers: new Set(["P1", "P2"]) }),
    );
    expect(out).toHaveLength(2);
    expect(out[0].offerId).toBe("P1"); // RED≤3% 试点排最前
    expect(out[0].priority).toBe(1);
    expect(out[0].reason).toContain("优先试点");
    expect(out[1].offerId).toBe("P2");
    expect(out[1].suggestedPrice).toBe(990); // 分两步：本轮降一半
  });

  it("翻绿降幅 3-5% → 分两步：本轮先降一半", () => {
    // cur=1010, compAvg=1000 → d=(1010-970)/1010≈3.96%；本轮降一半 → round(1010×(1-0.0198))=990
    const action = dropAction({ suggestedPrice: 970, currentPrice: 1010 });
    const out = applyAstraGuard(
      [action], [baseProduct({ currentPrice: 1010, competitorAvg: 1000 })],
      makeCtx({ greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].suggestedPrice).toBe(990);
    expect(out[0].reason).toContain("分两步");
  });

  it("翻绿降幅 >5% → 不追绿，转「退出弹性提升评估」（现有 -5% 阈值产出必然落此档）", () => {
    // cur=1060, compAvg=1000 → d=(1060-970)/1060≈8.5% > 5%
    const action = dropAction({ suggestedPrice: 970, currentPrice: 1060 });
    const out = applyAstraGuard(
      [action], [baseProduct({ currentPrice: 1060, competitorAvg: 1000 })],
      makeCtx({ greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(0);
  });

  it("翻绿价破底价 → 不追绿", () => {
    // cur=1000, compAvg=740 → 条款2: 1000 ≤ 725.2? 否；greenTarget=717.8 < floor 750
    const action = dropAction({ suggestedPrice: 950 });
    const out = applyAstraGuard(
      [action], [baseProduct({ competitorAvg: 740, floorPrice: 750 })],
      makeCtx({ greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(0);
  });
});

// ============================================================
// 条款3 g_BE 盈亏平衡校验
// ============================================================

describe("astra-guard — 条款3 g_BE 盈亏平衡", () => {
  it("无 GREEN 加持（增益按0计）→ 任何向下调价 g_BE>1 不可达，剔除", () => {
    // cur=1000, cost=500 → π(P)=250；p=990 → π(p)=242.5；g_BE=1.031 > 1+0
    const out = applyAstraGuard(
      [dropAction()], [baseProduct({ competitorAvg: 1000 })],
      makeCtx(), // greenOffers 空
    );
    expect(out).toHaveLength(0);
  });

  it("有 GREEN 且 g_BE ≤ 1.075 → 放行", () => {
    const out = applyAstraGuard(
      [dropAction()], [baseProduct({ competitorAvg: 1000 })],
      makeCtx({ greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].suggestedPrice).toBe(990);
  });

  it("有 GREEN 但幅度过大 → 幅度减到 g_BE 可达的临界值", () => {
    const config = unitEconomicsConfigFromEnv();
    const piCur = unitProfitRub(1000, 100, config);
    const out = applyAstraGuard(
      [dropAction({ suggestedPrice: 900 })], [baseProduct({ competitorAvg: 1000 })],
      makeCtx({ greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].suggestedPrice).toBe(945);
    expect(out[0].reason).toContain("临界值");
    const piNew = unitProfitRub(945, 100, config);
    expect(piCur / piNew).toBeLessThanOrEqual(1.075);
  });

  it("61N 的 g_BE/pCrit 使用 35% CPS 覆盖", () => {
    const previous = process.env.PROMO_CPS_RATE_OVERRIDES;
    process.env.PROMO_CPS_RATE_OVERRIDES = '{"MAR-YAM-61N-01":0.35}';
    try {
      const p = baseProduct({ offerId: "MAR-YAM-61N-01", competitorAvg: 1000 });
      const out = applyAstraGuard(
        [dropAction({ offerId: p.offerId, suggestedPrice: 900 })], [p],
        makeCtx({ greenOffers: new Set([p.offerId]) }),
      );
      expect(out).toHaveLength(1);
      expect(out[0].suggestedPrice).toBe(949);
      expect(out[0].reason).toContain("临界值");
    } finally {
      if (previous === undefined) delete process.env.PROMO_CPS_RATE_OVERRIDES;
      else process.env.PROMO_CPS_RATE_OVERRIDES = previous;
    }
  });

  it("候选价跨 Small→XS 时 g_BE 使用 XS 物流重算利润", () => {
    const config = unitEconomicsConfigFromEnv();
    const p = baseProduct({
      currentPrice: 1550, competitorAvg: 1550, costRub: 60, packagingRub: 60,
      logisticsRub: 243.84, fixedCostRub: 363.84, weightG: 200, exchangeRate: 12, floorPrice: 0,
    });
    const action = dropAction({ suggestedPrice: 1400, currentPrice: 1550 });
    const out = applyAstraGuard([action], [p], makeCtx({ greenOffers: new Set(["P1"]) }));
    expect(out).toHaveLength(1);
    expect(out[0].suggestedPrice).toBe(1400);
    const targetFixed = oglFixedCostRub(1400, { baseFixedCostRub: 120, weightG: 200, exchangeRate: 12 })!;
    const piCur = unitProfitRub(1550, 363.84, config);
    const piNew = unitProfitRub(1400, targetFixed, config);
    expect(piCur / piNew).toBeLessThanOrEqual(1.075);
  });

  it("新价单均利润 ≤0 → 剔除（降价即亏损）", () => {
    const out = applyAstraGuard(
      [dropAction({ suggestedPrice: 650 })], [baseProduct({ competitorAvg: 1000, fixedCostRub: 400 })],
      makeCtx({ greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(0);
  });

  it("现价单均利润 ≤0 → 剔除（应走利润修复而非降价）", () => {
    const action = dropAction({ suggestedPrice: 580, currentPrice: 600 });
    const out = applyAstraGuard(
      [action], [baseProduct({ currentPrice: 600, competitorAvg: 600, floorPrice: 500, fixedCostRub: 400 })],
      makeCtx({ greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(0);
  });
});

// ============================================================
// 条款5 止损线：净利率 + 试验回退
// ============================================================

describe("astra-guard — 条款5 净利率止损", () => {
  it("修正价净利率 <20%（含退货5%）→ 提到 20% 水位", () => {
    const action = dropAction({ suggestedPrice: 1700, currentPrice: 1800 });
    const fixedCostRub = 525.577235627;
    const out = applyAstraGuard(
      [action],
      [baseProduct({ currentPrice: 1800, competitorAvg: 1800, costRub: 350, fixedCostRub, floorPrice: 500 })],
      makeCtx({ greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].suggestedPrice).toBe(1772);
    expect(out[0].reason).toContain("净利率止损");
    const config = unitEconomicsConfigFromEnv();
    expect(unitProfitRub(1772, fixedCostRub, config) / 1772).toBeGreaterThanOrEqual(0.20);
  });

  it("净利率 20% 水位 ≥ 现价 → 禁止扩大优惠，剔除", () => {
    const action = dropAction({ suggestedPrice: 1100, currentPrice: 1200 });
    const out = applyAstraGuard(
      [action],
      [baseProduct({ currentPrice: 1200, competitorAvg: 1180, fixedCostRub: 800, floorPrice: 1100 })],
      makeCtx({ greenOffers: new Set(["P1"]) }),
    );
    expect(out).toHaveLength(0);
  });
});

describe("astra-guard — 条款5 试验14d无单回退", () => {
  const zeroSales = () => ({ recent: 0, prev: 0 });
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it("试验 ≥14d 且零单 → 生成回退动作（本轮涨 10% 分步逼近试验前价格）", () => {
    const state = emptyAstraState();
    state.trials.P1 = { preTrialPrice: 1100, startedAt: daysAgo(15), drops: 2 };
    const out = applyAstraGuard(
      [], [baseProduct({ currentPrice: 950 })],
      makeCtx({ sales14d: zeroSales, state }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("pricing");
    // target = min(1100, floor(950×1.10)=1045) = 1045（单次 ≤10% 硬约束）
    expect(out[0].suggestedPrice).toBe(1045);
    expect(out[0].reason).toContain("回退");
  });

  it("试验 <14d → 不回退（继续观察）", () => {
    const state = emptyAstraState();
    state.trials.P1 = { preTrialPrice: 1100, startedAt: daysAgo(10), drops: 2 };
    const out = applyAstraGuard(
      [], [baseProduct({ currentPrice: 950 })],
      makeCtx({ sales14d: zeroSales, state }),
    );
    expect(out).toHaveLength(0);
  });

  it("试验期间出单 → 试验成功结案，trial 清除且不回退", () => {
    const state = emptyAstraState();
    state.trials.P1 = { preTrialPrice: 1100, startedAt: daysAgo(20), drops: 2 };
    const out = applyAstraGuard(
      [], [baseProduct({ currentPrice: 950 })],
      makeCtx({ sales14d: () => ({ recent: 1, prev: 0 }), state }),
    );
    expect(out).toHaveLength(0);
    expect(state.trials.P1).toBeUndefined();
  });

  it("价格已回到试验前（±1%）→ trial 清除", () => {
    const state = emptyAstraState();
    state.trials.P1 = { preTrialPrice: 1000, startedAt: daysAgo(20), drops: 1 };
    applyAstraGuard(
      [], [baseProduct({ currentPrice: 995 })],
      makeCtx({ sales14d: zeroSales, state }),
    );
    expect(state.trials.P1).toBeUndefined();
  });

  it("今日已调过该品 → 回退让位（每 SKU 24h ≤1 次硬约束）", () => {
    const state = emptyAstraState();
    state.trials.P1 = { preTrialPrice: 1100, startedAt: daysAgo(15), drops: 2 };
    const out = applyAstraGuard(
      [], [baseProduct({ currentPrice: 950 })],
      makeCtx({ sales14d: zeroSales, state, isAdjustedToday: () => true }),
    );
    expect(out).toHaveLength(0);
  });

  it("试验前价格在 10% 步长内 → 一步回退到位（下轮 cur 回到位后 ±1% 清理 trial）", () => {
    const state = emptyAstraState();
    state.trials.P1 = { preTrialPrice: 1000, startedAt: daysAgo(15), drops: 1 };
    // cur=950 → target=min(1000, floor(1045))=1000 一步到位
    const out = applyAstraGuard(
      [], [baseProduct({ currentPrice: 950 })],
      makeCtx({ sales14d: zeroSales, state }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].suggestedPrice).toBe(1000);
  });
});

// ============================================================
// recordAstraTrial：执行后留档
// ============================================================

describe("recordAstraTrial — 降价试验留档", () => {
  it("首次降价记录试验前价格与 drops=1", () => {
    const state = emptyAstraState();
    recordAstraTrial(state, "P1", 1000, 950);
    expect(state.trials.P1.preTrialPrice).toBe(1000);
    expect(state.trials.P1.drops).toBe(1);
  });

  it("再次降价 drops 递增，preTrialPrice 保持首次值（回退目标是试验前）", () => {
    const state = emptyAstraState();
    recordAstraTrial(state, "P1", 1000, 950);
    recordAstraTrial(state, "P1", 950, 900);
    expect(state.trials.P1.preTrialPrice).toBe(1000);
    expect(state.trials.P1.drops).toBe(2);
  });

  it("涨价（含回退）不记录", () => {
    const state = emptyAstraState();
    recordAstraTrial(state, "P1", 950, 1000);
    expect(state.trials.P1).toBeUndefined();
  });
});
