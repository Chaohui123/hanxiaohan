import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@onzo/logger";
import {
  calculateUnitEconomics, effectivePriceRub, oglFixedCostRub, oglLogisticsCny,
  priceForTargetMargin, priceForUnitProfit, unitEconomicsConfigFromEnv, unitProfitRub,
} from "../src/unit-economics.js";

describe("CPS 默认与 offerId 覆盖", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("默认全店 CPS 为 23%", () => {
    vi.stubEnv("PROMO_CPS_RATE", undefined);
    vi.stubEnv("PROMO_CPS_RATE_OVERRIDES", undefined);
    expect(unitEconomicsConfigFromEnv("ANY").cpsRate).toBe(0.23);
  });

  it("61N 使用 35%，其他商品保持 23%", () => {
    vi.stubEnv("PROMO_CPS_RATE", "0.23");
    vi.stubEnv("PROMO_CPS_RATE_OVERRIDES", '{"MAR-YAM-61N-01":0.35}');
    expect(unitEconomicsConfigFromEnv("MAR-YAM-61N-01").cpsRate).toBe(0.35);
    expect(unitEconomicsConfigFromEnv("OTHER").cpsRate).toBe(0.23);
  });

  it("非法 override JSON warn 后回退，不抛异常", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.stubEnv("PROMO_CPS_RATE_OVERRIDES", "{bad json");
    expect(() => unitEconomicsConfigFromEnv("MAR-YAM-61N-01")).not.toThrow();
    expect(unitEconomicsConfigFromEnv("MAR-YAM-61N-01").cpsRate).toBe(0.23);
    expect(warn).toHaveBeenCalled();
  });

  it.each([-0.01, 1.01, "0.35", null])("非法 override 费率 %s 回退", (rate) => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.stubEnv("PROMO_CPS_RATE_OVERRIDES", JSON.stringify({ "MAR-YAM-61N-01": rate }));
    expect(unitEconomicsConfigFromEnv("MAR-YAM-61N-01").cpsRate).toBe(0.23);
  });

  it("calculateUnitEconomics 的 61N 跨档目标也使用 35%", () => {
    vi.stubEnv("PROMO_CPS_RATE_OVERRIDES", '{"MAR-YAM-61N-01":0.35}');
    const result = calculateUnitEconomics({ priceRub: 1500, costCny: 30, weightG: 200, exchangeRate: 12, offerId: "MAR-YAM-61N-01" });
    const config = unitEconomicsConfigFromEnv("MAR-YAM-61N-01");
    const fixed = oglFixedCostRub(result.floorPrice, { baseFixedCostRub: 420, weightG: 200, exchangeRate: 12 })!;
    expect(result.floorPrice).toBeGreaterThan(1500);
    expect(unitProfitRub(result.floorPrice, fixed, config) / result.floorPrice).toBeCloseTo(0.10, 10);
    expect(result.variableFeesRub).toBeCloseTo(1500 * (0.20 + 0.35 + 0.0033 + 0.05) + 30, 8);
  });
});

describe("OGL 官方费率边界", () => {
  it("1500₽/500g 使用 Extra Small", () => {
    expect(oglLogisticsCny(1500, 500)).toBeCloseTo(15.25, 10);
  });

  it("1500₽ 以上且 2000g 以内使用 Small", () => {
    expect(oglLogisticsCny(1500.01, 2000)).toBeCloseTo(63.88, 10);
    expect(oglLogisticsCny(7000, 2000)).toBeCloseTo(63.88, 10);
  });

  it("超价或超重不能套轻档", () => {
    expect(oglLogisticsCny(1500, 500.01)).toBeNull();
    expect(oglLogisticsCny(1500.01, 2000.01)).toBeNull();
    expect(oglLogisticsCny(7000.01, 100)).toBeNull();
  });
});

describe("统一单元经济", () => {
  const config = unitEconomicsConfigFromEnv();

  it("CPS、佣金、电子服务、国际运输、退货与全部固定成本同口径", () => {
    const result = calculateUnitEconomics({ priceRub: 1500, costCny: 30, weightG: 200, exchangeRate: 12, config });
    expect(result.logisticsRub).toBeCloseTo(94.08, 8);
    expect(result.packagingRub).toBe(60);
    expect(result.fixedCostRub).toBeCloseTo(514.08, 8);
    expect(result.variableFeesRub).toBeCloseTo(754.95, 8);
    expect(result.unitProfitRub).toBeCloseTo(230.97, 8);
    expect(result.marginPercent).toBeCloseTo(15.398, 8);
    const ogl = { baseFixedCostRub: result.costRub + result.packagingRub, weightG: 200, exchangeRate: 12 };
    const floorFixed = oglFixedCostRub(result.floorPrice, ogl)!;
    const astraFixed = oglFixedCostRub(result.astraMinPrice, ogl)!;
    expect(result.floorPrice).toBeGreaterThan(1500);
    expect(result.astraMinPrice).toBeGreaterThan(1500);
    expect(result.floorPrice).toBeGreaterThan(priceForTargetMargin(result.fixedCostRub, 0.10, config));
    expect(result.astraMinPrice).toBeGreaterThan(priceForTargetMargin(result.fixedCostRub, 0.20, config));
    expect(unitProfitRub(result.floorPrice, floorFixed, config) / result.floorPrice).toBeCloseTo(0.10, 10);
    expect(unitProfitRub(result.astraMinPrice, astraFixed, config) / result.astraMinPrice).toBeCloseTo(0.20, 10);
  });

  it("pCrit 从现价 Small 跨到 XS 后按 XS 固定成本达到目标利润", () => {
    const current = calculateUnitEconomics({ priceRub: 1550, costCny: 5, weightG: 200, exchangeRate: 12, config });
    const ogl = { baseFixedCostRub: current.costRub + current.packagingRub, weightG: 200, exchangeRate: 12 };
    const targetProfit = current.unitProfitRub / 1.075;
    const naive = priceForUnitProfit(targetProfit, current.fixedCostRub, config);
    const solved = priceForUnitProfit(targetProfit, ogl.baseFixedCostRub, config, ogl);
    const solvedFixed = oglFixedCostRub(solved, ogl)!;
    expect(naive).toBeLessThanOrEqual(1500);
    expect(solved).toBeLessThanOrEqual(1500);
    expect(solvedFixed).toBeLessThan(current.fixedCostRub);
    expect(unitProfitRub(solved, solvedFixed, config)).toBeCloseTo(targetProfit, 8);
  });

  it("卖家价与促销价同时为正取较低者", () => {
    expect(effectivePriceRub(1000, 1200)).toBe(1000);
    expect(effectivePriceRub(1000, 800)).toBe(800);
    expect(effectivePriceRub(1000, 0)).toBe(1000);
    expect(effectivePriceRub(0, 800)).toBe(800);
  });

  it("缺重量显式阻断且所有输出保持有限值", () => {
    const result = calculateUnitEconomics({ priceRub: 1000, costCny: 30, weightG: 0, exchangeRate: 12, config });
    expect(result.pricingBlockers).toContain("MISSING_WEIGHT");
    expect(result.floorPrice).toBe(0);
    for (const value of [result.fixedCostRub, result.logisticsRub, result.unitProfitRub, result.floorPrice]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
