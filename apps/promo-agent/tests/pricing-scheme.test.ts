// 自动调价：竞品触发与全费用 10% 净贡献底价。
import { describe, it, expect } from "vitest";
import { getRecommendation } from "../src/scorer.js";
import {
  priceForTargetMargin, unitEconomicsConfigFromEnv, unitProfitRub,
} from "../src/unit-economics.js";

describe("getRecommendation — 调价触发", () => {
  it("价格高于竞品均价 5%+ 且利润充足 → pricing（不利降价）", () => {
    const r = getRecommendation(60, 30, -10);
    expect(r.recommendation).toBe("pricing");
    expect(r.reason).toContain("不利可降价");
  });

  it("价格低于竞品均价 15%+ 且利润充足 → pricing（适度涨价）", () => {
    const r = getRecommendation(60, 30, 20);
    expect(r.recommendation).toBe("pricing");
    expect(r.reason).toContain("涨价");
  });

  it("利润率低于 20% → pricing（利润修复）", () => {
    const r = getRecommendation(60, 12, 3);
    expect(r.recommendation).toBe("pricing");
    expect(r.reason).toContain("利润");
  });

  it("价格劣势但利润不足 20% → 优先利润修复而非降价", () => {
    const r = getRecommendation(60, 15, -12);
    expect(r.recommendation).toBe("pricing");
    expect(r.reason).toContain("利润");
  });

  it("评分低于阈值 → skip", () => {
    expect(getRecommendation(30, 30, -10).recommendation).toBe("skip");
  });

  it("指标正常 → copy（利润好/价格平）或 skip", () => {
    const r = getRecommendation(60, 35, 5);
    expect(["copy", "skip"]).toContain(r.recommendation);
  });
});

describe("底价公式（全部 variable 费用 + 固定成本，净贡献率≥10%）", () => {
  const config = unitEconomicsConfigFromEnv();

  it("底价本身的单均净贡献率精确达到 10%", () => {
    for (const fixedCostRub of [100, 1000, 5000]) {
      const floor = priceForTargetMargin(fixedCostRub, config.targetNetMarginRate, config);
      expect(unitProfitRub(floor, fixedCostRub, config) / floor).toBeCloseTo(0.10, 10);
      expect(floor).toBeGreaterThan(fixedCostRub);
    }
  });

  it("电子服务费 15₽ 下限、2% 区间、200₽ 上限三种价格带均成立", () => {
    for (const fixedCostRub of [10, 1000, 30000]) {
      const floor = priceForTargetMargin(fixedCostRub, 0.10, config);
      expect(unitProfitRub(floor, fixedCostRub, config)).toBeCloseTo(floor * 0.10, 8);
    }
  });
});
