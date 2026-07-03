import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.stubGlobal("AbortSignal", { timeout: vi.fn(() => ({})) });

describe("GlmClient", () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it("sends request with correct auth header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
    });

    const { GlmClient } = await import("../src/glm-client.js");
    const client = new GlmClient({ apiKey: "test-key" });
    const result = await client.chatCompletion({ model: "glm-4v-flash", messages: [{ role: "user", content: "hi" }] });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Authorization"]).toBe("Bearer test-key");
    expect(result.content).toBe("ok");
  });

  it("retries on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "retry-ok" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }),
    });

    const { GlmClient } = await import("../src/glm-client.js");
    const client = new GlmClient({ apiKey: "k", maxRetries: 1 });
    const result = await client.chatCompletion({ model: "glm-4v-flash", messages: [{ role: "user", content: "test" }] });
    expect(result.content).toBe("retry-ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("parses JSON from code blocks", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '```json\n{"key":"val"}\n```' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    });

    const { GlmClient } = await import("../src/glm-client.js");
    const client = new GlmClient({ apiKey: "k" });
    const result = await client.chatCompletion({ model: "glm-4v-flash", messages: [{ role: "user", content: "json please" }] });
    expect(result.parsed).toEqual({ key: "val" });
  });
});
