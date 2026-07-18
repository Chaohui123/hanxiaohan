// ============================================================
// DeepSeek v1 API Client — Bearer auth, fixed model ID
// Base URL: https://api.deepseek.com/v1
// Model: deepseek-v4-pro
// ============================================================

import { logger } from "@onzo/logger";

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.LLM_MODEL_ID || "deepseek-v4-pro";

export interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DeepSeekRequest {
  model?: string;
  messages: DeepSeekMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface DeepSeekResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class DeepSeekApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
    this.name = "DeepSeekApiError";
  }
}

/**
 * Standard DeepSeek v1 chat completion.
 * Always uses Bearer auth header, model ID from env or default deepseek-v4-pro.
 */
export async function deepseekChatCompletion(
  messages: DeepSeekMessage[],
  options?: { temperature?: number; maxTokens?: number },
): Promise<DeepSeekResponse> {
  if (!DEEPSEEK_KEY) {
    throw new DeepSeekApiError("DEEPSEEK_API_KEY not configured", 401, "");
  }

  const body: DeepSeekRequest = {
    model: DEEPSEEK_MODEL,
    messages,
    temperature: options?.temperature ?? 0.3,
    max_tokens: options?.maxTokens ?? 4096,
  };

  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();

  if (!resp.ok) {
    // 400: bad request / 402: payment required / 401: invalid key
    const status = resp.status;
    logger.error({ status, body: text.slice(0, 300) }, "DeepSeek API error");
    throw new DeepSeekApiError(
      `DeepSeek API ${status}: ${text.slice(0, 200)}`,
      status,
      text,
    );
  }

  return JSON.parse(text) as DeepSeekResponse;
}

/**
 * Convenience: simple string-in, string-out completion.
 */
export async function deepseekComplete(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const resp = await deepseekChatCompletion([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);
  return resp.choices[0]?.message?.content || "";
}

/**
 * Check DeepSeek connectivity.
 */
export async function deepseekHealthCheck(): Promise<boolean> {
  try {
    await deepseekChatCompletion([{ role: "user", content: "ping" }], { maxTokens: 1 });
    return true;
  } catch {
    return false;
  }
}
