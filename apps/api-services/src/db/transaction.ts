// ============================================================
// Drizzle Transaction Wrapper + Retry Engine
// - withTransaction: ACID transaction with auto-rollback
// - executeWithRetry: Exponential backoff retry (max 3 attempts)
// Phase 1: SQLite only (no PostgreSQL per .claude/rules.md)
// ============================================================

import { getDrizzle } from "./drizzle-client.js";
import { getDb, serializedWrite } from "./connection.js";
import type { DbAdapter } from "./connection.js";
import { logger } from "@onzo/logger";

// ---- Types ----

export interface TransactionResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Only retry on these error substrings; empty = retry all */
  retryOnlyOn?: string[];
  /** Never retry on these error substrings */
  skipRetryOn?: string[];
  onRetry?: (attempt: number, error: string, delayMs: number) => void;
}

const DEFAULT_RETRY: Required<Omit<RetryOptions, "retryOnlyOn" | "skipRetryOn" | "onRetry">> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

/**
 * Execute a callback within a SQLite ACID transaction via Drizzle.
 *
 * Any error thrown inside `fn` triggers ROLLBACK automatically.
 * All Ozon writes, inventory mutations, and multi-table operations
 * MUST use this wrapper.
 *
 * Example:
 *   const result = await withTransaction(async (tx) => {
 *     await tx.insert(listingRecords).values({ ... });
 *     await tx.update(inventory).set({ ... }).where(...);
 *     return { productId: 123 };
 *   });
 */
export async function withTransaction<T>(
  fn: (tx: Awaited<ReturnType<typeof getDrizzle>>) => Promise<T>
): Promise<TransactionResult<T>> {
  const db = await getDb();
  if (!db) {
    return { success: false, error: "Database unavailable — cannot start transaction" };
  }

  // Serialize writes to prevent SQLite lock conflicts
  return serializedWrite(async () => {
    try {
      await db.run("BEGIN IMMEDIATE");
    } catch (err) {
      return {
        success: false as const,
        error: `BEGIN IMMEDIATE failed: ${(err as Error).message}`,
      };
    }

    try {
      const drizzleDb = await getDrizzle();
      const data = await fn(drizzleDb);
      await db.run("COMMIT");
      return { success: true as const, data };
    } catch (err) {
      const reason = (err as Error).message;
      logger.error({ err: reason }, "Transaction failed — rolling back");

      try {
        await db.run("ROLLBACK");
      } catch (rbErr) {
        logger.error({ err: (rbErr as Error).message }, "ROLLBACK also failed");
      }

      return { success: false as const, error: reason };
    }
  });
}

/**
 * Execute an async operation with exponential backoff retry.
 *
 * Delay curve: 1s → 2s → 4s (capped at maxDelayMs)
 * Skips retry immediately on non-retryable errors (validation, auth, etc.)
 *
 * Example:
 *   const result = await executeWithRetry(
 *     () => ozonClient.createDraft(product),
 *     { skipRetryOn: ["ValidationError", "AuthError"] }
 *   );
 */
export async function executeWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<TransactionResult<T>> {
  const maxRetries = options.maxRetries ?? DEFAULT_RETRY.maxRetries;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const retryOnlyOn = options.retryOnlyOn ?? [];
  const skipRetryOn = options.skipRetryOn ?? [];

  let lastError = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const data = await fn(attempt);
      if (attempt > 0) {
        logger.info({ attempt }, "Operation succeeded after retry");
      }
      return { success: true, data };
    } catch (err) {
      lastError = (err as Error).message;
      const errorName = (err as Error).name;

      // Never retry on these — fail immediately
      if (skipRetryOn.some((kw) => lastError.includes(kw) || errorName === kw)) {
        logger.warn({ attempt, err: lastError, reason: "non-retryable" }, "Operation failed — skipping retry");
        return { success: false, error: lastError };
      }

      // Only retry on specified errors
      if (retryOnlyOn.length > 0 && !retryOnlyOn.some((kw) => lastError.includes(kw) || errorName === kw)) {
        logger.warn({ attempt, err: lastError, reason: "not in retryOnlyOn list" }, "Operation failed — skipping retry");
        return { success: false, error: lastError };
      }

      // Final attempt exhausted
      if (attempt >= maxRetries) {
        logger.error({ attempt, totalAttempts: maxRetries + 1, err: lastError }, "Operation exhausted all retries");
        return { success: false, error: lastError };
      }

      // Calculate delay: baseDelayMs * 2^attempt, capped, with full jitter
      const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const delayMs = Math.floor(Math.random() * exponentialDelay);

      logger.warn({ attempt: attempt + 1, nextRetryMs: delayMs, err: lastError }, "Operation failed — retrying with backoff");
      options.onRetry?.(attempt + 1, lastError, delayMs);

      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return { success: false, error: lastError };
}

/**
 * Convenience: wrap a Drizzle transaction with retry.
 * Combines withTransaction + executeWithRetry.
 */
export async function withTransactionRetry<T>(
  fn: (tx: Awaited<ReturnType<typeof getDrizzle>>) => Promise<T>,
  retryOptions?: RetryOptions
): Promise<TransactionResult<T>> {
  return executeWithRetry(
    () => withTransaction(fn),
    {
      // By default, don't retry validation/auth errors inside transactions
      skipRetryOn: ["ValidationError", "AuthError", "FatalError", ...(retryOptions?.skipRetryOn ?? [])],
      ...retryOptions,
    }
  );
}
