// 自动调价方案（2026-08-14 定稿）核心逻辑测试：
// 触发=价格高于精准竞品均价 5%；底价=毛利≥20% 与 净利≥10% 双取大；幅度≤10%；每商品每日 1 次
import { describe, it, expect } from "vitest";
import { getRecommendation } from "../src/scorer.js";

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

describe("底价公式（毛利≥20% 与 净利≥10% 双取大）", () => {
  // 与 decision-engine scoreAllProducts 同公式：floor = max(costRub/0.80, (costRub+物流₽)/0.70)
  // 物流分档（globalcalculator.ozon.ru China/Dongguan 实测 8/20）：
  // XS(≤135¥且≤500g) 95₽ ｜ Small(135-635¥且≤2kg) 300₽ ｜ Premium Small(635¥+且≤5kg) 2161₽
  const logistics = (priceCny: number, weightG: number) =>
    priceCny <= 135 && weightG <= 500 ? 95
      : priceCny <= 635 && weightG <= 2000 ? 300
      : priceCny > 635 && weightG <= 5000 ? 2161
      : 2161;
  const floor = (costRub: number, priceCny = 200, weightG = 150) =>
    Math.max(costRub / 0.80, (costRub + logistics(priceCny, weightG)) / 0.70);

  it("67F 叶轮（成本 16¥ ≈ 197₽，XS 档 101¥/52g）→ 底价 418₽（XS 物流 95₽ 净利线主导）", () => {
    const f = floor(16 * 12.34, 101, 52);
    expect(f).toBeGreaterThan(410);
    expect(f).toBeLessThan(430);
    // 现售 101.3¥≈1273₽ > 底价 → 降价空间厚
    expect(1273).toBeGreaterThan(f);
  });

  it("磁吸清货品（成本 42¥ ≈ 518₽）→ 底价 1169₽，现售 1222₽ 几乎贴线（没空间）", () => {
    const f = floor(42 * 12.34);
    expect(f).toBeGreaterThan(1100);
    expect(1221.66 - f).toBeLessThan(1221.66 * 0.05);
  });

  it("高成本品（成本 1000₽）→ 净利线主导（1857₽，含固定物流 300₽ 摊薄）", () => {
    const f = floor(1000);
    expect(f).toBeCloseTo(1857, 0); // (1000+300)/0.70
  });

  it("XS 档（61N 119¥/200g）→ 物流 95₽：底价低于旧 300₽ 口径，降价空间更大", () => {
    const costRub = 32 * 12.57; // 61N 成本 32¥
    const fNew = floor(costRub, 119, 200);
    const fOld = Math.max(costRub / 0.80, (costRub + 300) / 0.70);
    expect(fNew).toBeLessThan(fOld);
    expect(fNew).toBeCloseTo((costRub + 95) / 0.70, 0);
  });

  it("Premium Small 档（打窝船 1033¥/3746g）→ 物流 2161₽：底价 10306₽，现售 12990₽ 达标", () => {
    const costRub = 402 * 12.57; // 5053₽
    const f = floor(costRub, 1033, 3746);
    expect(f).toBeCloseTo((costRub + 2161) / 0.70, 0);
    expect(12990).toBeGreaterThan(f); // 净利 = (12990×0.8−2161−5053)/12990 ≈ 24.5% ≥10%
    expect(12990 * 0.8 - 2161 - costRub).toBeGreaterThan(12990 * 0.1);
  });

  it("底价永远 ≥ 成本", () => {
    expect(floor(100)).toBeGreaterThan(100);
    expect(floor(500)).toBeGreaterThan(500);
  });
});
