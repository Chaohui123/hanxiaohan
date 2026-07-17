// ============================================================
// Base GLM API Client — shared by vision and text models
// ============================================================

const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

import type { TokenTracker } from "./token-tracker.js";

export interface GlmClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  tokenTracker?: TokenTracker;
}

export interface GlmRequestOptions {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }>;
  }>;
  temperature?: number;
  topP?: number;
  responseFormat?: { type: "json_object" } | { type: "text" };
  maxTokens?: number;
}

export class GlmClient {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;
  private maxRetries: number;
  private tokenTracker?: TokenTracker;

  constructor(config: GlmClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? ZHIPU_BASE_URL;
    this.timeout = config.timeout ?? 60000;
    this.maxRetries = config.maxRetries ?? 2;
    this.tokenTracker = config.tokenTracker;
  }

  /**
   * Send a chat completion request to the GLM API.
   */
  async chatCompletion<T = Record<string, unknown>>(options: GlmRequestOptions): Promise<{
    content: string;
    parsed: T | null;
    tokensUsed: { prompt: number; completion: number; total: number };
    model: string;
  }> {
    // Check token limit before ANY API call
    this.tokenTracker?.checkLimit();

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        const response = await fetch(this.baseUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: options.model,
            messages: options.messages,
            temperature: options.temperature ?? 0.3,
            top_p: options.topP ?? 0.9,
            response_format: options.responseFormat,
            max_tokens: options.maxTokens,
          }),
          signal: AbortSignal.timeout(this.timeout),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw new GlmApiError(
            `GLM API error: ${response.status} ${response.statusText}`,
            response.status,
            errorBody
          );
        }

        const data = await response.json() as Record<string, unknown>;
        const content = (data.choices as Record<string, unknown>[] | undefined)?.[0]?.message as Record<string, string> | undefined;
        const contentStr: string = content?.content ?? "";

        // Try to parse JSON from the content (all our prompts request JSON)
        let parsed: T | null = null;
        try {
          // Handle cases where JSON is wrapped in ```json blocks
          const jsonMatch = contentStr.match(/```json\s*([\s\S]*?)\s*```/) || contentStr.match(/```\s*([\s\S]*?)\s*```/);
          const jsonStr = jsonMatch ? jsonMatch[1] : contentStr;
          parsed = JSON.parse(jsonStr.trim()) as T;
        } catch {
          // Content not valid JSON — caller should handle
        }

        const tokensUsed = {
          prompt: (data.usage as Record<string, number> | undefined)?.prompt_tokens ?? 0,
          completion: (data.usage as Record<string, number> | undefined)?.completion_tokens ?? 0,
          total: (data.usage as Record<string, number> | undefined)?.total_tokens ?? 0,
        };

        // Track token usage for cost monitoring
        this.tokenTracker?.record({
          model: (data.model as string) ?? options.model,
          promptTokens: tokensUsed.prompt,
          completionTokens: tokensUsed.completion,
          totalTokens: tokensUsed.total,
          provider: "glm",
        });

        return {
          content: contentStr.trim(),
          parsed,
          tokensUsed,
          model: (data.model as string) ?? options.model,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on auth errors
        if (
          error instanceof GlmApiError &&
          (error.statusCode === 401 || error.statusCode === 403)
        ) {
          throw error;
        }

        // Last attempt — throw
        if (attempt > this.maxRetries) {
          throw lastError;
        }

        // Wait before retry (1s, 2s)
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    throw lastError!;
  }
}

export class GlmApiError extends Error {
  public readonly statusCode: number;
  public readonly responseBody?: string;

  constructor(message: string, statusCode: number, responseBody?: string) {
    super(message);
    this.name = "GlmApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}
