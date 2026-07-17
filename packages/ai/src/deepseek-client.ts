// ============================================================
// DeepSeek API Client — OpenAI-compatible endpoint
// Replaces GLM-5.2 for text translation and category matching
// Model routing: deepseek-v4-flash (P0 listing), deepseek-v4-pro (P2 comparison only)
// ============================================================

import type { TokenTracker } from "./token-tracker.js";

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  flashModel: string;
  proModel: string;
  timeout?: number;
  maxRetries?: number;
  tokenTracker?: TokenTracker;
}

export type DeepSeekModelTier = "flash" | "pro";

export interface DeepSeekRequestOptions {
  model: DeepSeekModelTier;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" } | { type: "text" };
}

export class DeepSeekClient {
  private config: DeepSeekClientResolved;
  private tokenTracker?: TokenTracker;

  constructor(config: DeepSeekConfig) {
    this.config = { ...config, timeout: config.timeout ?? 60000, maxRetries: config.maxRetries ?? 2 };
    this.tokenTracker = config.tokenTracker;
  }

  async chatCompletion<T = Record<string, unknown>>(options: DeepSeekRequestOptions): Promise<{
    content: string;
    parsed: T | null;
    tokensUsed: { prompt: number; completion: number; total: number };
    model: string;
  }> {
    const modelName = options.model === "pro"
      ? this.config.proModel
      : this.config.flashModel;

    // Check token limit before ANY API call
    this.tokenTracker?.checkLimit();

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.config.maxRetries + 1; attempt++) {
      try {
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelName,
            messages: options.messages,
            temperature: options.temperature ?? 0.3,
            max_tokens: options.maxTokens ?? 4000,
            response_format: options.responseFormat,
          }),
          signal: AbortSignal.timeout(this.config.timeout),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          const err = new DeepSeekApiError(
            `DeepSeek API error: ${response.status} ${response.statusText}`,
            response.status,
            errorBody
          );

          if (response.status === 401 || response.status === 403) throw err;
          if (attempt > this.config.maxRetries) throw err;

          await new Promise((r) => setTimeout(r, 1000 * attempt));
          lastError = err;
          continue;
        }

        const data = await response.json() as Record<string, unknown>;
        // DeepSeek-V4 reasoning models put final answer in content;
        // reasoning_content (if present) contains chain-of-thought.
        const msg = data.choices as Record<string, unknown>[] | undefined;
        const choice = msg?.[0]?.message as Record<string, string> | undefined;
        const content: string = choice?.content || choice?.reasoning_content || "";

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
        this.tokenTracker?.record({
          model: (data.model as string) ?? modelName,
          promptTokens: tokensUsed.prompt,
          completionTokens: tokensUsed.completion,
          totalTokens: tokensUsed.total,
          provider: "deepseek",
        });

        return {
          content: content.trim(),
          parsed,
          tokensUsed,
          model: (data.model as string) ?? modelName,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt > this.config.maxRetries) throw lastError;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    throw lastError!;
  }
}

export class DeepSeekApiError extends Error {
  public readonly statusCode: number;
  public readonly responseBody?: string;

  constructor(message: string, statusCode: number, responseBody?: string) {
    super(message);
    this.name = "DeepSeekApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

type DeepSeekClientResolved = Required<Omit<DeepSeekConfig, "flashModel" | "proModel" | "tokenTracker">> & {
  flashModel: string;
  proModel: string;
  tokenTracker?: TokenTracker;
};
