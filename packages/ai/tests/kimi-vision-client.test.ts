import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.stubGlobal("AbortSignal", { timeout: vi.fn(() => ({})) });

describe("KimiVisionClient", () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it("sends OpenAI-compatible request with auth header, default endpoint and kimi-k3", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        model: "kimi-k3",
      }),
    });

    const { KimiVisionClient } = await import("../src/kimi-vision-client.js");
    const client = new KimiVisionClient({ apiKey: "test-key" });
    const result = await client.chatCompletion({
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
            { type: "text", text: "describe" },
          ],
        },
      ],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect(opts.headers["Authorization"]).toBe("Bearer test-key");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body as string) as {
      model: string;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.model).toBe("kimi-k3");
    // image_url content parts are passed through unchanged
    expect(body.messages[1].content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
      { type: "text", text: "describe" },
    ]);
    expect(result.content).toBe("ok");
  });

  it("parses JSON from code blocks", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```json\n{"key":"val"}\n```' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    });

    const { KimiVisionClient } = await import("../src/kimi-vision-client.js");
    const client = new KimiVisionClient({ apiKey: "k" });
    const result = await client.chatCompletion({ messages: [{ role: "user", content: "json please" }] });
    expect(result.parsed).toEqual({ key: "val" });
  });

  it("falls back to reasoning_content when content is empty", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "", reasoning_content: '{"fromReasoning":true}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    });

    const { KimiVisionClient } = await import("../src/kimi-vision-client.js");
    const client = new KimiVisionClient({ apiKey: "k" });
    const result = await client.chatCompletion({ messages: [{ role: "user", content: "think" }] });
    expect(result.content).toBe('{"fromReasoning":true}');
    expect(result.parsed).toEqual({ fromReasoning: true });
  });

  it("retries on 429 with backoff then succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => "rate limited" })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "retry-ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

    const { KimiVisionClient } = await import("../src/kimi-vision-client.js");
    const client = new KimiVisionClient({ apiKey: "k", maxRetries: 1 });
    const result = await client.chatCompletion({ messages: [{ role: "user", content: "test" }] });
    expect(result.content).toBe("retry-ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx then succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => "down" })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "recovered" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

    const { KimiVisionClient } = await import("../src/kimi-vision-client.js");
    const client = new KimiVisionClient({ apiKey: "k", maxRetries: 1 });
    const result = await client.chatCompletion({ messages: [{ role: "user", content: "test" }] });
    expect(result.content).toBe("recovered");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 401/403", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "bad key" });

    const { KimiVisionClient, KimiApiError } = await import("../src/kimi-vision-client.js");
    const client = new KimiVisionClient({ apiKey: "bad", maxRetries: 3 });
    await expect(client.chatCompletion({ messages: [{ role: "user", content: "test" }] }))
      .rejects.toBeInstanceOf(KimiApiError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("records token usage with provider kimi and fires onUsage", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: "kimi-k3",
      }),
    });

    const { KimiVisionClient } = await import("../src/kimi-vision-client.js");
    const { TokenTracker } = await import("../src/token-tracker.js");
    const tracker = new TokenTracker();
    const onUsage = vi.fn();
    const client = new KimiVisionClient({ apiKey: "k", tokenTracker: tracker, onUsage });

    await client.chatCompletion({ messages: [{ role: "user", content: "test" }] });

    expect(tracker.getTodayUsage()).toBe(15);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      model: "kimi-k3",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      provider: "kimi",
    });
  });
});

describe("KimiOcrClient (GlmVisionClient backward-compat alias)", () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it("keeps legacy GlmVisionClient construction working with full-endpoint baseUrl", async () => {
    mockFetch
      // First call: server-side image download (Kimi endpoint rejects external URLs)
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "image/jpeg" },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })
      // Second call: the actual chat completion
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"rawText":"Brand X 500ml","structured":{"brand":"Brand X"}}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          model: "kimi-k3",
        }),
      });

    const { GlmVisionClient } = await import("../src/ocr.js");
    // Business layer passes baseUrl as the full chat/completions endpoint
    const client = new GlmVisionClient({
      apiKey: "test-key",
      baseUrl: "https://api.kimi.com/coding/v1/chat/completions",
      model: "kimi-k3",
    });
    const result = await client.extractTextFromImage({ url: "https://example.com/p.jpg" });

    // calls[0] is the image download (with anti-hotlink Referer)
    const [dlUrl, dlOpts] = mockFetch.mock.calls[0];
    expect(dlUrl).toBe("https://example.com/p.jpg");
    expect((dlOpts.headers as Record<string, string>).Referer).toBeTruthy();
    // calls[1] is the API request with the downloaded image inlined as base64
    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toBe("https://api.kimi.com/coding/v1/chat/completions");
    const body = JSON.parse(opts.body as string) as { model: string; response_format?: { type: string } };
    expect(body.model).toBe("kimi-k3");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(result.rawText).toBe("Brand X 500ml");
    expect(result.structured.brand).toBe("Brand X");
  });

  it("falls back to rawText when response is not JSON", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "plain text, no json" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });

    const { KimiOcrClient } = await import("../src/ocr.js");
    const client = new KimiOcrClient({ apiKey: "k" });
    const result = await client.extractTextFromImage({ base64: "QUJD", mimeType: "image/jpeg" });

    expect(result.rawText).toBe("plain text, no json");
    expect(result.structured).toEqual({});

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string) as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    // base64 input is converted to a data: URL image block
    expect(body.messages[1].content[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,QUJD" },
    });
  });

  it("batch OCR isolates per-image failures", async () => {
    // URL inputs are downloaded first, then sent to the API — route mocks by URL.
    mockFetch.mockImplementation(async (input: unknown) => {
      const u = String(input);
      if (u === "https://example.com/good.jpg") {
        return {
          ok: true,
          headers: { get: () => "image/jpeg" },
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        };
      }
      if (u === "https://example.com/bad.jpg") {
        // Download itself fails → per-image failure isolation
        return { ok: false, status: 404, statusText: "Not Found", text: async () => "not found" };
      }
      // API call (only reached for the good image)
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"rawText":"ok","structured":{}}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      };
    });

    const { KimiOcrClient } = await import("../src/ocr.js");
    const client = new KimiOcrClient({ apiKey: "k" });
    const results = await client.extractTextFromImages([
      { url: "https://example.com/good.jpg" },
      { url: "https://example.com/bad.jpg" },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].rawText).toBe("ok");
    expect(results[1].rawText).toContain("OCR failed");
  });
});
