// ============================================================
// GLM Rate Limiter — Simple token bucket for API call control
// Prevents exceeding Zhipu API rate limits during batch operations
// ============================================================

export interface GlmRateLimiterConfig {
  maxConcurrent: number; // max in-flight requests
  tokensPerMinute: number; // max requests per minute
}

export class GlmRateLimiter {
  private maxConcurrent: number;
  private tokensPerMinute: number;
  private inFlight = 0;
  private tokens: number;
  private lastRefill: number;

  // Queues
  private waitQueue: Array<() => void> = [];

  constructor(config?: Partial<GlmRateLimiterConfig>) {
    this.maxConcurrent = config?.maxConcurrent ?? 10;
    this.tokensPerMinute = config?.tokensPerMinute ?? 60;
    this.tokens = this.tokensPerMinute;
    this.lastRefill = Date.now();
  }

  /**
   * Acquire a call slot. Blocks if at capacity or rate limit.
   */
  async acquire(): Promise<void> {
    // Check concurrency limit
    if (this.inFlight >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    // Check rate limit with proportional refill
    this.refillTokens();
    if (this.tokens <= 0) {
      const waitMs = Math.max(100, this.timeUntilNextToken());
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.refillTokens();
    }

    if (this.tokens > 0) {
      this.tokens--;
    }
    // If still 0, consume anyway (allow burst above rate; next call will wait)
    this.inFlight++;
  }

  /**
   * Release a call slot.
   */
  release(): void {
    this.inFlight--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  /**
   * Wrap an async function with rate limiting.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get metrics() {
    return {
      inFlight: this.inFlight,
      maxConcurrent: this.maxConcurrent,
      tokensRemaining: this.tokens,
      tokensPerMinute: this.tokensPerMinute,
      queued: this.waitQueue.length,
    };
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs >= 60000) {
      // Full refill after 60s window
      this.tokens = this.tokensPerMinute;
      this.lastRefill = now;
    } else {
      // Proportional refill: add tokens for elapsed time
      const refillRate = this.tokensPerMinute / 60000;
      const newTokens = elapsedMs * refillRate;
      if (newTokens >= 1) {
        this.tokens = Math.min(this.tokensPerMinute, this.tokens + newTokens);
        this.lastRefill = now;
      }
    }
  }

  private timeUntilNextToken(): number {
    if (this.tokens > 0) return 0;
    // Estimate time for 1 token
    return Math.ceil(60000 / this.tokensPerMinute);
  }
}
