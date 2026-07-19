// ============================================================
// Token Counter — js-tiktoken based precise token counting
// Replaces the naive heuristic in rag-v2/token-counter.ts
// Supports DeepSeek (cl100k_base) and Kimi K3 / GLM (o200k_base) models
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _encodingFn: any = null;

async function getTiktoken() {
  if (!_encodingFn) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tiktoken = await import("js-tiktoken") as any;
    _encodingFn = tiktoken.encodingForModel;
  }
  return _encodingFn;
}

// ---- Model → encoding mapping ----
// DeepSeek uses same tokenizer as GPT-4 (cl100k_base)
// GLM uses a similar tokenizer (approximate with o200k_base)
const MODEL_ENCODING: Record<string, "cl100k_base" | "o200k_base"> = {
  "deepseek-v4-pro": "cl100k_base",
  "deepseek-v4-flash": "cl100k_base",
  "deepseek-chat": "cl100k_base",
  "kimi-k3": "o200k_base",
  "moonshot-v1-8k-vision": "o200k_base",
  "glm-4.6v": "o200k_base",
};

/**
 * Count tokens in a string for a specific model.
 * Falls back to ~4 chars/token heuristic if js-tiktoken unavailable.
 */
export async function countTokens(text: string, model?: string): Promise<number> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encodingForModel: any = await getTiktoken();
    const encodingName = model ? MODEL_ENCODING[model] || "cl100k_base" : "cl100k_base";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enc: any = encodingForModel(encodingName);
    const count = (enc.encode(text) as { length: number }).length;
    (enc as { free?: () => void }).free?.();
    return count;
  } catch {
    // Fallback: rough heuristic (~4 chars per token for English, ~1.5 for CJK)
    return Math.ceil(text.length / 4);
  }
}

/** Synchronous fallback — fast estimate only, for hot paths */
export function estimateTokensFast(text: string): number {
  // Rough: count CJK/Russian chars as ~1.5 tokens, Latin as ~0.25 tokens
  let tokens = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
        (code >= 0x0400 && code <= 0x04ff) || // Cyrillic
        (code >= 0x3000 && code <= 0x303f)) { // CJK Symbols
      tokens += 1.5;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

/**
 * Check if text + system prompt fits within model's context window.
 */
export function isWithinLimit(
  text: string,
  systemPrompt: string,
  maxTokens: number,
  model?: string,
): { within: boolean; estimated: number; remaining: number } {
  const estimated = estimateTokensFast(text) + estimateTokensFast(systemPrompt);
  return {
    within: estimated <= maxTokens,
    estimated,
    remaining: Math.max(0, maxTokens - estimated),
  };
}

// ---- Model context windows ----
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "deepseek-v4-pro": 131_072,
  "deepseek-v4-flash": 131_072,
  "kimi-k3": 1_000_000,
  "moonshot-v1-8k-vision": 128_000,
  "glm-4.6v": 128_000,
};

/**
 * Get the max input tokens for a model (leaving room for completion).
 * Uses 90% of context window for input.
 */
export function getMaxInputTokens(model: string): number {
  const window = MODEL_CONTEXT_WINDOWS[model] || 128_000;
  return Math.floor(window * 0.9);
}

/**
 * Validate that a prompt will fit within model limits.
 * Throws a descriptive error if it would exceed the context window.
 */
export async function validateTokenLimit(
  messages: Array<{ role: string; content: string }>,
  model: string,
): Promise<{ totalTokens: number; maxTokens: number; safe: boolean }> {
  const maxInput = getMaxInputTokens(model);
  const fullText = messages.map((m) => m.content).join("\n");
  const totalTokens = await countTokens(fullText, model);

  if (totalTokens > maxInput) {
    console.warn(`[TokenCounter] Token limit exceeded: ${totalTokens}/${maxInput} for model ${model} (${messages.length} messages)`);
    return { totalTokens, maxTokens: maxInput, safe: false };
  }

  return { totalTokens, maxTokens: maxInput, safe: true };
}
