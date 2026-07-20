// ============================================================
// Kimi K3 Vision Client — OpenAI-compatible endpoint (api.kimi.com/coding/v1)
// Primary vision pipeline: product image OCR / visual understanding.
// Native image_url input, 1M context. GLM retained only for
// embedding / image-generation backup (see glm-client.ts).
// ============================================================

import type { TokenTracker, TokenUsage } from "./token-tracker.js";

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_MODEL = "kimi-k3";

export interface KimiVisionClientConfig {
  apiKey: string;
  /** API root, e.g. https://api.kimi.com/coding/v1 — /chat/completions is appended */
  baseUrl?: string;
  /** Vision model ID — defaults to kimi-k3 */
  model?: string;
  timeout?: number;
  maxRetries?: number;
  tokenTracker?: TokenTracker;
  /** Extra usage callback invoked after every successful call */
  onUsage?: (usage: Omit<TokenUsage, "timestamp">) => void;
}

export type KimiMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export interface KimiVisionRequestOptions {
  /** Override the client-level default model */
  model?: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: KimiMessageContent;
  }>;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" } | { type: "text" };
}

export class KimiVisionClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeout: number;
  private maxRetries: number;
  private tokenTracker?: TokenTracker;
  private onUsage?: (usage: Omit<TokenUsage, "timestamp">) => void;

  constructor(config: KimiVisionClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = config.model ?? DEFAULT_MODEL;
    this.timeout = config.timeout ?? 60000;
    this.maxRetries = config.maxRetries ?? 2;
    this.tokenTracker = config.tokenTracker;
    this.onUsage = config.onUsage;
  }

  /**
   * Send a chat completion request to the Kimi K3 API.
   * Retries with exponential backoff on 429 / 5xx / network errors.
   * 401 / 403 (and other 4xx) are thrown immediately — never retried.
   */
  async chatCompletion<T = Record<string, unknown>>(options: KimiVisionRequestOptions): Promise<{
    content: string;
    parsed: T | null;
    tokensUsed: { prompt: number; completion: number; total: number };
    model: string;
  }> {
    const modelName = options.model ?? this.model;

    // Check token limit before ANY API call
    this.tokenTracker?.checkLimit();

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelName,
            messages: options.messages,
            temperature: options.temperature ?? 1, // K3 endpoint allows only temperature=1
            max_tokens: options.maxTokens ?? 4000,
            response_format: options.responseFormat,
          }),
          signal: AbortSignal.timeout(this.timeout),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          const err = new KimiApiError(
            `Kimi API error: ${response.status} ${response.statusText} — ${errorBody.slice(0, 300)}`,
            response.status,
            errorBody
          );

          // Auth failures and other client errors (except 429) are not retryable
          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable || attempt > this.maxRetries) throw err;

          await this.backoff(attempt);
          lastError = err;
          continue;
        }

        const data = await response.json() as Record<string, unknown>;
        // K3 reasoning responses put the final answer in content;
        // reasoning_content (if present) holds the chain-of-thought.
        const choices = data.choices as Record<string, unknown>[] | undefined;
        const message = choices?.[0]?.message as Record<string, string> | undefined;
        const content: string = message?.content || message?.reasoning_content || "";

        // Try to parse JSON from the content (all our prompts request JSON)
        let parsed: T | null = null;
        try {
          const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/```\s*([\s\S]*?)\s*```/);
          const jsonStr = jsonMatch ? jsonMatch[1] : content;
          parsed = JSON.parse(jsonStr.trim()) as T;
        } catch { /* non-JSON content — caller handles */ }

        const tokensUsed = {
          prompt: (data.usage as Record<string, number> | undefined)?.prompt_tokens ?? 0,
          completion: (data.usage as Record<string, number> | undefined)?.completion_tokens ?? 0,
          total: (data.usage as Record<string, number> | undefined)?.total_tokens ?? 0,
        };

        // Track token usage for cost monitoring
        const usage: Omit<TokenUsage, "timestamp"> = {
          model: (data.model as string) ?? modelName,
          promptTokens: tokensUsed.prompt,
          completionTokens: tokensUsed.completion,
          totalTokens: tokensUsed.total,
          provider: "kimi",
        };
        this.tokenTracker?.record(usage);
        this.onUsage?.(usage);

        return {
          content: content.trim(),
          parsed,
          tokensUsed,
          model: (data.model as string) ?? modelName,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // KimiApiError reaches here only when non-retryable or out of attempts
        if (error instanceof KimiApiError) throw error;

        // Network/timeout error — retry with backoff
        if (attempt > this.maxRetries) throw lastError;
        await this.backoff(attempt);
      }
    }

    throw lastError!;
  }

  /** Exponential backoff: 1s, 2s, 4s, ... */
  private backoff(attempt: number): Promise<void> {
    return new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
  }
}

export class KimiApiError extends Error {
  public readonly statusCode: number;
  public readonly responseBody?: string;

  constructor(message: string, statusCode: number, responseBody?: string) {
    super(message);
    this.name = "KimiApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}
