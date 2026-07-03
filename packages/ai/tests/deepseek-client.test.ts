import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("DeepSeekClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("AbortSignal", { timeout: vi.fn(() => ({})) });
  });

  it("sends chat completion request with correct headers", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"key":"value"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: "deepseek-v4-flash",
      }),
    });

    const { DeepSeekClient } = await import("../src/deepseek-client.js");
    const client = new DeepSeekClient({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com/v1",
      flashModel: "deepseek-v4-flash",
      proModel: "deepseek-v4-pro",
    });

    const result = await client.chatCompletion({
      model: "flash",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/chat/completions");
    expect(opts.headers["Authorization"]).toBe("Bearer test-key");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(result.content).toBe('{"key":"value"}');
    expect(result.parsed).toEqual({ key: "value" });
  });

  it("parses JSON from code blocks", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```json\n{"x":1}\n```' } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        model: "deepseek-v4-flash",
      }),
    });

    const { DeepSeekClient } = await import("../src/deepseek-client.js");
    const client = new DeepSeekClient({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com/v1",
      flashModel: "deepseek-v4-flash",
      proModel: "deepseek-v4-pro",
    });

    const result = await client.chatCompletion({ model: "flash", messages: [{ role: "user", content: "test" }] });
    expect(result.parsed).toEqual({ x: 1 });
  });

  it("retries on server error", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

    const { DeepSeekClient } = await import("../src/deepseek-client.js");
    const client = new DeepSeekClient({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com/v1",
      flashModel: "deepseek-v4-flash",
      proModel: "deepseek-v4-pro",
      maxRetries: 1,
    });

    const result = await client.chatCompletion({ model: "flash", messages: [{ role: "user", content: "test" }] });
    expect(result.content).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
