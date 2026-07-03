// ============================================================
// Exponential Backoff Retry Policy (with Full Jitter)
// ============================================================

import { RetryableError } from "./errors.js";

export interface RetryConfig {
  maxRetries: number; // max retry attempts (default: 3)
  baseDelayMs: number; // initial delay (default: 1000)
  maxDelayMs: number; // max delay cap (default: 10000)
  useJitter: boolean; // use full jitter (default: true)
  retryableStatusCodes: number[]; // [429, 500, 502, 503, 504]
}

export interface RetryMetrics {
  totalRetries: number;
  lastRetryTimestamp: Date | null;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  useJitter: true,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

export class RetryPolicy {
  private config: RetryConfig;
  private _metrics: RetryMetrics = {
    totalRetries: 0,
    lastRetryTimestamp: null,
  };

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a function with retry logic.
   * Throws the last error if all retries are exhausted.
   */
  async execute<T>(
    fn: () => Promise<T>,
    context?: { attempt?: number }
  ): Promise<T> {
    const maxAttempts = this.config.maxRetries + 1; // initial + retries
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await fn();
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryable(lastError)) {
          throw lastError;
        }

        if (attempt < maxAttempts) {
          const delay = this.calculateDelayMs(attempt);
          this._metrics.totalRetries++;
          this._metrics.lastRetryTimestamp = new Date();
          await this.sleep(delay);
        }
      }
    }

    throw lastError!;
  }

  isRetryable(error: Error): boolean {
    // Network errors are always retryable
    if (error.name === "NetworkError" || error.name === "TypeError" || error.name === "AbortError") {
      return true;
    }

    // RetryableError and its subclasses
    if (error instanceof RetryableError) {
      return true;
    }

    // Check status code on generic error-like objects
    const errWithCode = error as { statusCode?: unknown };
    if (
      "statusCode" in error &&
      typeof errWithCode.statusCode === "number"
    ) {
      return this.config.retryableStatusCodes.includes(
        errWithCode.statusCode
      );
    }

    return false;
  }

  calculateDelayMs(attempt: number): number {
    // attempt 1 → baseDelay * 2^0 = 1s
    // attempt 2 → baseDelay * 2^1 = 2s
    // attempt 3 → baseDelay * 2^2 = 4s
    let delay = Math.min(
      this.config.baseDelayMs * Math.pow(2, attempt - 1),
      this.config.maxDelayMs
    );

    if (this.config.useJitter) {
      // Full jitter: random between 0 and delay
      delay = Math.floor(Math.random() * delay);
    }

    return delay;
  }

  get metrics(): Readonly<RetryMetrics> {
    return { ...this._metrics };
  }

  reset(): void {
    this._metrics = { totalRetries: 0, lastRetryTimestamp: null };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
