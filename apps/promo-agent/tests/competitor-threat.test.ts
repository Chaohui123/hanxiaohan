import { describe, it, expect } from "vitest";
import {
  priceRelevanceScore,
  salesThreatScore,
  ratingThreatScore,
  competitorThreatScore,
  threatWeightedAverage,
  THREAT_MIN_SCORE,
} from "../src/competitor-threat.js";

describe("priceRelevanceScore — 价格相关性 (0-50)", () => {
  it("同价 → 满分 50", () => {
    expect(priceRelevanceScore(1000, 1000)).toBe(50);
  });

  it("偏离恰好 0.3 → 0 分（带内边界）", () => {
    expect(priceRelevanceScore(1300, 1000)).toBeCloseTo(0, 10);
    expect(priceRelevanceScore(700, 1000)).toBeCloseTo(0, 10);
  });

  it("偏离 >0.3 → 0 分（价格带外不构成直接威胁）", () => {
    expect(priceRelevanceScore(1301, 1000)).toBe(0);
    expect(priceRelevanceScore(699, 1000)).toBe(0);
    expect(priceRelevanceScore(2000, 1000)).toBe(0);
  });

  it("带内线性：偏离 0.15 → 25 分", () => {
    expect(priceRelevanceScore(1150, 1000)).toBeCloseTo(25, 10);
    expect(priceRelevanceScore(850, 1000)).toBeCloseTo(25, 10);
  });

  it("非法输入（0/负价）→ 0 分", () => {
    expect(priceRelevanceScore(0, 1000)).toBe(0);
    expect(priceRelevanceScore(1000, 0)).toBe(0);
    expect(priceRelevanceScore(-100, 1000)).toBe(0);
    expect(priceRelevanceScore(1000, -1000)).toBe(0);
  });
});

describe("salesThreatScore — 销量威胁 (0-30)", () => {
  it("≥100 → 30（含 100 边界）", () => {
    expect(salesThreatScore(100)).toBe(30);
    expect(salesThreatScore(500)).toBe(30);
  });

  it("10-99 → 20", () => {
    expect(salesThreatScore(99)).toBe(20);
    expect(salesThreatScore(10)).toBe(20);
  });

  it("1-9 → 10", () => {
    expect(salesThreatScore(9)).toBe(10);
    expect(salesThreatScore(1)).toBe(10);
  });

  it("0 → 0", () => {
    expect(salesThreatScore(0)).toBe(0);
  });
});

describe("ratingThreatScore — 评分威胁 (0-20)", () => {
  it("≥4.5 → 20（含 4.5 边界）", () => {
    expect(ratingThreatScore(4.5)).toBe(20);
    expect(ratingThreatScore(4.9)).toBe(20);
  });

  it("4.0-4.49 → 12", () => {
    expect(ratingThreatScore(4.49)).toBe(12);
    expect(ratingThreatScore(4.0)).toBe(12);
  });

  it("<4.0 → 5", () => {
    expect(ratingThreatScore(3.99)).toBe(5);
    expect(ratingThreatScore(0)).toBe(5);
  });
});

describe("competitorThreatScore — 综合分", () => {
  it("满配竞品（同价+热销+高评分）→ 100 分", () => {
    expect(competitorThreatScore({ price: 1000, rating: 4.8, salesCount: 200 }, 1000)).toBeCloseTo(100, 10);
  });

  it("恰好 40 分（阈值边界）", () => {
    // 偏离 0.15 → 25 ｜ 销量 9 → 10 ｜ 评分 3.9 → 5 ＝ 40
    expect(competitorThreatScore({ price: 1150, rating: 3.9, salesCount: 9 }, 1000)).toBeCloseTo(THREAT_MIN_SCORE, 10);
  });
});

describe("threatWeightedAverage — 阈值过滤 + 威胁分加权", () => {
  const ourPrice = 1000;

  it("全低分被滤 → 0（走成本定价分支）", () => {
    // 价格带外(0) + 0 销量(0) + 低评分(5) = 5 分 < 40
    const avg = threatWeightedAverage(
      [
        { price: 2000, rating: 3.0, salesCount: 0 },
        { price: 300, rating: 2.0, salesCount: 1 }, // 带外(0)+10+5=15
      ],
      ourPrice,
    );
    expect(avg).toBe(0);
  });

  it("空列表 → 0", () => {
    expect(threatWeightedAverage([], ourPrice)).toBe(0);
  });

  it("恰好 40 分保留（≥阈值），单竞品均价=其价格", () => {
    const avg = threatWeightedAverage([{ price: 1150, rating: 3.9, salesCount: 9 }], ourPrice);
    expect(avg).toBeCloseTo(1150, 10);
  });

  it("39.99 分被滤（<阈值不纳入）", () => {
    // 偏离 0.1501 → 24.983 ｜ 销量 9 → 10 ｜ 评分 3.9 → 5 ≈ 39.98 < 40
    const avg = threatWeightedAverage([{ price: 1150.1, rating: 3.9, salesCount: 9 }], ourPrice);
    expect(avg).toBe(0);
  });

  it("高低分混合：低分被滤，只剩高分", () => {
    const strong = { price: 1000, rating: 4.8, salesCount: 200 }; // 100 分
    const weak = { price: 500, rating: 3.0, salesCount: 0 }; // 带外 0+0+5=5 分
    expect(threatWeightedAverage([strong, weak], ourPrice)).toBeCloseTo(1000, 10);
  });

  it("加权平均正确性：威胁分越高对均价影响越大", () => {
    // A：同价 1000 → 50 ｜ 销量 100 → 30 ｜ 评分 4.5 → 20 ＝ 100 分
    const a = { price: 1000, rating: 4.5, salesCount: 100 };
    // B：偏离 0.1 → 33.33 ｜ 销量 10 → 20 ｜ 评分 4.0 → 12 ≈ 65.33 分
    const b = { price: 900, rating: 4.0, salesCount: 10 };
    const sa = competitorThreatScore(a, ourPrice);
    const sb = competitorThreatScore(b, ourPrice);
    expect(sa).toBeCloseTo(100, 10);
    expect(sb).toBeGreaterThan(THREAT_MIN_SCORE);

    const expected = (1000 * sa + 900 * sb) / (sa + sb);
    const avg = threatWeightedAverage([a, b], ourPrice);
    expect(avg).toBeCloseTo(expected, 8);
    // 加权结果应靠近高威胁竞品 A 的价格（1000），而非简单均价 950
    expect(avg).toBeGreaterThan(950);
  });
});
