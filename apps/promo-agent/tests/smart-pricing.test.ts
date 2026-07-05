import { describe, it, expect } from "vitest";
import { validateBeforeApply } from "../src/smart-pricing.js";

describe("smart-pricing — validateBeforeApply", () => {
  const baseSuggestion = {
    offerId: "test1", name: "Test", cost: 100, currentPrice: 1500,
    suggestedPrice: 1200, competitorAvg: 1100, exchangeRate: 12,
    marginPercent: 15, changePercent: -20, needsExtraConfirm: false,
    reason: "test",
  };

  it("变动幅度 ≤20% 应通过验证", () => {
    expect(validateBeforeApply({ ...baseSuggestion, changePercent: 15 })).toBeNull();
    expect(validateBeforeApply({ ...baseSuggestion, changePercent: -15 })).toBeNull();
  });

  it("变动幅度 >20% 应拒绝", () => {
    const result = validateBeforeApply({ ...baseSuggestion, changePercent: 25 });
    expect(result).toContain("20%");
  });

  it("建议价格为0应拒绝", () => {
    const result = validateBeforeApply({ ...baseSuggestion, suggestedPrice: 0 });
    expect(result).toContain("无效");
  });

  it("建议价格为负数应拒绝", () => {
    const result = validateBeforeApply({ ...baseSuggestion, suggestedPrice: -100 });
    expect(result).toContain("无效");
  });
});
