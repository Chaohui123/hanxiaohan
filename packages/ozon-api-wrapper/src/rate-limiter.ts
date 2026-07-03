// ============================================================
// Token Bucket Rate Limiter
// ============================================================

export interface RateLimiterConfig {
  tokensPerInterval: number; // max tokens that refill per interval (e.g., 30)
  intervalMs: number; // interval duration (e.g., 60000 = 1 min)
  maxBurst: number; // max tokens that can accumulate (e.g., 20)
}

export interface RateLimiterState {
  tokensRemaining: number;
  lastRefill: Date;
  nextRefillIn: number; // ms
}

export class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private readonly config: Required<RateLimiterConfig>;
  private pendingResolvers: Array<{
    resolve: (value: number) => void;
    tokens: number;
  }> = [];

  constructor(config: RateLimiterConfig) {
    this.config = {
      tokensPerInterval: config.tokensPerInterval,
      intervalMs: config.intervalMs,
      maxBurst: config.maxBurst,
    };
    this.tokens = this.config.maxBurst; // start full
    this.lastRefillTime = Date.now();
  }

  /**
   * Block until the requested number of tokens are available.
   * Returns the wait time in ms (0 if no wait needed).
   */
  async consume(count: number = 1): Promise<number> {
    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      return 0;
    }

    // Not enough tokens — calculate wait time for next refill
    const waitMs = this.timeUntilNextToken();
    return new Promise<number>((resolve) => {
      this.pendingResolvers.push({ resolve, tokens: count });
      // Schedule retry after refill
      setTimeout(() => {
        this.processPending();
      }, waitMs + 10); // +10ms buffer
    });
  }

  /**
   * Non-blocking check. Returns whether tokens were consumed and the wait time if not.
   */
  tryConsume(count: number = 1): { accepted: boolean; waitMs: number } {
    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      return { accepted: true, waitMs: 0 };
    }

    return { accepted: false, waitMs: this.timeUntilNextToken() };
  }

  get state(): RateLimiterState {
    this.refill();
    return {
      tokensRemaining: this.tokens,
      lastRefill: new Date(this.lastRefillTime),
      nextRefillIn: this.timeUntilNextToken(),
    };
  }

  reset(): void {
    this.tokens = this.config.maxBurst;
    this.lastRefillTime = Date.now();
    this.pendingResolvers = [];
  }

  // ---- private ----

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;

    if (elapsed >= this.config.intervalMs) {
      // Full refill — but never exceed maxBurst
      this.tokens = this.config.maxBurst;
      this.lastRefillTime = now;
      return;
    }

    // Partial refill proportional to elapsed time
    const refillRate = this.config.tokensPerInterval / this.config.intervalMs;
    const newTokens = elapsed * refillRate;

    if (newTokens >= 1) {
      this.tokens = Math.min(this.config.maxBurst, this.tokens + newTokens);
      this.lastRefillTime = now;
    }
  }

  private timeUntilNextToken(): number {
    if (this.tokens >= 1) return 0;

    const tokensNeeded = 1 - this.tokens;
    const refillRate = this.config.tokensPerInterval / this.config.intervalMs;
    return Math.ceil((tokensNeeded / refillRate));
  }

  private processPending(): void {
    this.refill();

    while (this.pendingResolvers.length > 0) {
      const pending = this.pendingResolvers[0];

      if (this.tokens >= pending.tokens) {
        this.tokens -= pending.tokens;
        this.pendingResolvers.shift();
        pending.resolve(0);
      } else {
        // Re-enqueue with retry timer
        const waitMs = this.timeUntilNextToken();
        setTimeout(() => this.processPending(), waitMs + 10);
        return;
      }
    }
  }
}
