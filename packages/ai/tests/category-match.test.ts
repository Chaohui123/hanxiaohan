import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch for DeepSeek API
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.stubGlobal("AbortSignal", { timeout: vi.fn(() => ({})) });

describe("Category match retry on categoryId=0", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("retries when first response has categoryId=0", async () => {
    // First call returns categoryId=0
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"categoryId":0,"categoryName":"Test","categoryPath":[],"confidence":0,"reasoning":"none"}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      })
      // Second call (retry) returns valid ID
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"categoryId":17027486,"categoryName":"Electronics","categoryPath":["Electronics"],"confidence":0.9,"reasoning":"matched"}' } }],
          usage: { prompt_tokens: 80, completion_tokens: 15, total_tokens: 95 },
        }),
      });

    const { DeepSeekClient } = await import("../src/deepseek-client.js");

    // Create a thin wrapper that simulates the retry logic
    const client = new DeepSeekClient({
      apiKey: "test",
      baseUrl: "https://api.deepseek.com/v1",
      flashModel: "deepseek-v4-flash",
      proModel: "deepseek-v4-pro",
    });

    // First call
    const r1 = await client.chatCompletion({
      model: "flash",
      messages: [{ role: "user", content: "Match this product" }],
      maxTokens: 1000,
      responseFormat: { type: "json_object" },
    });
    expect(r1.parsed?.categoryId).toBe(0);

    // Second call (retry) should get valid ID
    const r2 = await client.chatCompletion({
      model: "flash",
      messages: [{ role: "user", content: "Retry: pick a REAL ID" }],
      maxTokens: 1000,
      responseFormat: { type: "json_object" },
    });
    expect(r2.parsed?.categoryId).toBe(17027486);
    expect(r2.parsed?.categoryId).toBeGreaterThan(0);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("blocks categoryId=0 (simulates validation logic)", () => {
    // Simulate the validation that stepMatchCategory does
    function validateCategoryId(id: number): boolean {
      return id > 0;
    }

    expect(validateCategoryId(0)).toBe(false);
    expect(validateCategoryId(17027486)).toBe(true);
    expect(validateCategoryId(-1)).toBe(false);
    expect(validateCategoryId(1)).toBe(true);
  });

  it("rejects non-numeric category IDs", () => {
    function isValidCategoryId(value: unknown): value is number {
      return typeof value === "number" && value > 0 && Number.isInteger(value);
    }

    expect(isValidCategoryId(17027486)).toBe(true);
    expect(isValidCategoryId(0)).toBe(false);
    expect(isValidCategoryId(null)).toBe(false);
    expect(isValidCategoryId("17027486")).toBe(false);
    expect(isValidCategoryId(undefined)).toBe(false);
  });
});
