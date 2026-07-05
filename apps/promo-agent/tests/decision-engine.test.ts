import { describe, it, expect } from "vitest";
import {
  scoreMargin,
  scorePriceAdvantage,
  scoreStock,
  scoreSalesGrowth,
  scoreRating,
  getRecommendation,
  planActions,
} from "../src/decision-engine.js";

// ============================================================
// 评分函数
// ============================================================

describe("scoreMargin", () => {
  it("高利润率应得高分", () => {
    expect(scoreMargin(50)).toBe(1.0);
    expect(scoreMargin(40)).toBe(1.0);
  });

  it("中等利润率应得中等分", () => {
    expect(scoreMargin(30)).toBe(0.8);
    expect(scoreMargin(20)).toBe(0.6);
  });

  it("低利润率应得低分", () => {
    expect(scoreMargin(10)).toBe(0.4);
    expect(scoreMargin(5)).toBe(0.2);
  });

  it("负利润率应得0分", () => {
    expect(scoreMargin(-10)).toBe(0);
    expect(scoreMargin(0)).toBe(0);
  });
});

describe("scorePriceAdvantage", () => {
  it("比竞品便宜20%应得高分", () => {
    const score = scorePriceAdvantage(20);
    expect(score).toBeGreaterThan(0.8);
  });

  it("比竞品便宜30%应得满分", () => {
    expect(scorePriceAdvantage(30)).toBe(1.0);
  });

  it("与竞品同价应得0.5分", () => {
    expect(scorePriceAdvantage(0)).toBe(0.5);
  });

  it("比竞品贵应得低分", () => {
    const score = scorePriceAdvantage(-10);
    expect(score).toBeLessThan(0.5);
  });

  it("比竞品贵30%应得0分", () => {
    expect(scorePriceAdvantage(-30)).toBe(0);
  });
});

describe("scoreStock", () => {
  it("库存充足应得满分", () => {
    expect(scoreStock(50)).toBe(1.0);
    expect(scoreStock(100)).toBe(1.0);
  });

  it("库存不足应得低分", () => {
    expect(scoreStock(5)).toBe(0.4);
    expect(scoreStock(1)).toBe(0.2);
  });

  it("库存为0应得0分", () => {
    expect(scoreStock(0)).toBe(0);
  });
});

describe("scoreSalesGrowth", () => {
  it("高增长应得高分", () => {
    expect(scoreSalesGrowth(50)).toBe(1.0);
    expect(scoreSalesGrowth(100)).toBe(1.0); // capped at 50
  });

  it("无增长应得0分", () => {
    expect(scoreSalesGrowth(0)).toBe(0);
  });

  it("中等增长应得中等分", () => {
    expect(scoreSalesGrowth(25)).toBe(0.5);
  });
});

describe("scoreRating", () => {
  it("高评分应得满分", () => {
    expect(scoreRating(4.5)).toBe(1.0);
    expect(scoreRating(5.0)).toBe(1.0);
  });

  it("无评分应得中等分", () => {
    expect(scoreRating(0)).toBe(0.5);
  });

  it("低评分应得低分", () => {
    expect(scoreRating(2.5)).toBe(0.2);
  });
});

// ============================================================
// 推荐策略
// ============================================================

describe("getRecommendation", () => {
  it("评分低于阈值 → skip", () => {
    const r = getRecommendation(35, 15, 5);
    expect(r.recommendation).toBe("skip");
    expect(r.reason).toContain("评分过低");
  });

  it("高利润+价格劣势 → copy操作", () => {
    const r = getRecommendation(60, 20, 5);
    expect(r.recommendation).toBe("copy");
    expect(r.reason).toContain("文案");
  });

  it("低利润 → pricing操作", () => {
    const r = getRecommendation(55, 10, 5);
    expect(r.recommendation).toBe("pricing");
    expect(r.reason).toContain("价格");
  });

  it("价格优势过大(>15%) → pricing操作", () => {
    const r = getRecommendation(60, 20, 20);
    expect(r.recommendation).toBe("pricing");
  });

  it("利润率低+价格劣势 → pricing（仅pricing，copy_and_pricing需交叉条件）", () => {
    const r = getRecommendation(55, 10, 20);
    expect(r.recommendation).toBe("pricing");
  });

  it("各项正常 → skip", () => {
    const r = getRecommendation(55, 20, 10);
    expect(r.recommendation).toBe("skip");
    expect(r.reason).toContain("正常");
  });
});

// ============================================================
// 行动规划
// ============================================================

describe("planActions", () => {
  const baseProduct = {
    offerId: "test1",
    name: "Test Product",
    cost: 100,
    currentPrice: 1500,
    stock: 50,
    marginPercent: 20,
    competitorAvg: 1400,
    priceAdvantage: 5,
    salesGrowth7d: 10,
    rating: 4.0,
    totalScore: 65,
    breakdown: { margin: 80, priceAdvantage: 60, stock: 80, salesGrowth: 40, rating: 60 },
    reason: "test",
  };

  it("评分低于阈值 → skip", () => {
    const scored = [{ ...baseProduct, offerId: "low", totalScore: 35, recommendation: "skip" as const }];
    const actions = planActions(scored);
    expect(actions).toHaveLength(0);
  });

  it("推荐skip的商品不生成action", () => {
    const scored = [{ ...baseProduct, recommendation: "skip" as const }];
    const actions = planActions(scored);
    expect(actions).toHaveLength(0);
  });

  it("pricing推荐生成调价action", () => {
    const scored = [{ ...baseProduct, recommendation: "pricing" as const }];
    const actions = planActions(scored);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("pricing");
    expect(actions[0].suggestedPrice).toBeDefined();
    expect(actions[0].suggestedPrice).toBeGreaterThan(0);
  });

  it("copy推荐生成文案action", () => {
    const scored = [{ ...baseProduct, recommendation: "copy" as const }];
    const actions = planActions(scored);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("copy");
    expect(actions[0].suggestedPrice).toBeUndefined();
  });

  it("多个产品按总分排序生成actions", () => {
    const scored = [
      { ...baseProduct, offerId: "a", totalScore: 70, recommendation: "pricing" as const },
      { ...baseProduct, offerId: "b", totalScore: 50, recommendation: "copy" as const },
      { ...baseProduct, offerId: "c", totalScore: 60, recommendation: "pricing" as const },
    ];
    const actions = planActions(scored);
    expect(actions).toHaveLength(3);
    expect(actions[0].priority).toBe(1);
    expect(actions[2].priority).toBe(3);
  });
});
