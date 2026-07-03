// ============================================================
// Token Tracker — LLM cost monitoring + daily limit enforcement
// Stores per-call usage to SQLite, enforces .env LLM_DAILY_TOKEN_LIMIT
// ============================================================

export interface TokenUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: string;
  provider: "glm" | "deepseek";
}

export interface TokenTrackerConfig {
  dailyLimit?: number; // from LLM_DAILY_TOKEN_LIMIT env
  onLimitExceeded?: (usage: TokenUsage) => void;
  persistFn?: (usage: TokenUsage) => Promise<void>;
}

export class TokenTracker {
  private dailyUsage: Map<string, number> = new Map(); // date → total tokens
  private dailyLimit: number;
  private onLimitExceeded?: (usage: TokenUsage) => void;
  private persistFn?: (usage: TokenUsage) => Promise<void>;

  constructor(config?: TokenTrackerConfig) {
    this.dailyLimit = config?.dailyLimit ?? 0;
    this.onLimitExceeded = config?.onLimitExceeded;
    this.persistFn = config?.persistFn;
  }

  /** Record a single API call's token usage. Returns false if limit exceeded. */
  async record(usage: Omit<TokenUsage, "timestamp">): Promise<boolean> {
    const date = new Date().toISOString().split("T")[0];
    const current = this.dailyUsage.get(date) ?? 0;
    const newTotal = current + usage.totalTokens;
    this.dailyUsage.set(date, newTotal);

    const entry: TokenUsage = { ...usage, timestamp: new Date().toISOString() };

    // Persist to DB
    if (this.persistFn) {
      await this.persistFn(entry).catch(() => {});
    }

    // Check daily limit
    if (this.dailyLimit > 0 && newTotal > this.dailyLimit) {
      this.onLimitExceeded?.(entry);
      return false;
    }

    return true;
  }

  /** Get today's total token usage. */
  getTodayUsage(): number {
    const date = new Date().toISOString().split("T")[0];
    return this.dailyUsage.get(date) ?? 0;
  }

  /** Get whether the daily limit has been exceeded. */
  isLimitExceeded(): boolean {
    if (this.dailyLimit <= 0) return false;
    return this.getTodayUsage() >= this.dailyLimit;
  }

  /** Reset today's counter (for testing). */
  resetToday(): void {
    const date = new Date().toISOString().split("T")[0];
    this.dailyUsage.delete(date);
  }
}

/** Cost estimation per 1M tokens (approximate, for reporting). */
export const TOKEN_COST_PER_M = {
  "glm-4.6v-flash": { prompt: 0, completion: 0 }, // free tier
  "deepseek-v4-flash": { prompt: 0.14, completion: 0.28 }, // USD
  "deepseek-v4-pro": { prompt: 0.55, completion: 1.10 },
} as Record<string, { prompt: number; completion: number }>;

/** Estimate cost in USD from token usage. */
export function estimateCost(usage: TokenUsage): number {
  const rates = TOKEN_COST_PER_M[usage.model];
  if (!rates) return 0;
  return (usage.promptTokens / 1_000_000) * rates.prompt +
    (usage.completionTokens / 1_000_000) * rates.completion;
}
