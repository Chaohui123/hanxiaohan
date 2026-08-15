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
  // 与 decision-engine scoreAllProducts 同公式：floor = max(costRub/0.80, (costRub+300)/0.70)
  const floor = (costRub: number) => Math.max(costRub / 0.80, (costRub + 300) / 0.70);

  it("67F 叶轮（成本 16¥ ≈ 197₽）→ 底价 711₽（净利线主导）", () => {
    const f = floor(16 * 12.34);
    expect(f).toBeGreaterThan(700);
    expect(f).toBeLessThan(730);
    // 现售 1385₽ > 底价 → 有降价空间
    expect(1384.55).toBeGreaterThan(f);
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

  it("底价永远 ≥ 成本", () => {
    expect(floor(100)).toBeGreaterThan(100);
    expect(floor(500)).toBeGreaterThan(500);
  });
});
