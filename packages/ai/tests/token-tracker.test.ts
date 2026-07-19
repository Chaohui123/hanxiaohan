import { describe, it, expect } from "vitest";
import { TokenTracker, TokenLimitExceededError, estimateCost } from "../src/token-tracker.js";

describe("TokenTracker", () => {
  it("allows calls within limit", async () => {
    const tracker = new TokenTracker({ dailyLimit: 1000 });
    const ok = await tracker.record({ model: "deepseek-v4-flash", promptTokens: 100, completionTokens: 200, totalTokens: 300, provider: "deepseek" });
    expect(ok).toBe(true);
    tracker.checkLimit(); // should not throw
  });

  it("blocks when limit exceeded", async () => {
    const tracker = new TokenTracker({ dailyLimit: 500 });
    await tracker.record({ model: "deepseek-v4-flash", promptTokens: 400, completionTokens: 200, totalTokens: 600, provider: "deepseek" });
    expect(() => tracker.checkLimit()).toThrow(TokenLimitExceededError);
  });

  it("resets block after resetToday", async () => {
    const tracker = new TokenTracker({ dailyLimit: 100 });
    await tracker.record({ model: "x", promptTokens: 200, completionTokens: 0, totalTokens: 200, provider: "kimi" });
    expect(() => tracker.checkLimit()).toThrow(TokenLimitExceededError);

    // resetToday resets the daily counter + unblocks
    tracker.resetToday();
    expect(() => tracker.checkLimit()).not.toThrow();
    expect(tracker.getTodayUsage()).toBe(0);
  });

  it("estimateCost returns correct values", () => {
    const cost = estimateCost({ model: "deepseek-v4-flash", promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, timestamp: "", provider: "deepseek" });
    expect(cost).toBeCloseTo(0.14, 2);
  });

  it("estimateCost returns 0 for unknown model", () => {
    expect(estimateCost({ model: "unknown", promptTokens: 1000, completionTokens: 0, totalTokens: 1000, timestamp: "", provider: "kimi" })).toBe(0);
  });
});
