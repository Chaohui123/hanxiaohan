// ============================================================
// Dead Letter Auto-Retry — replaces n8n auto-retry-notify workflow
// Resets retryable dead letters (api_error/network/rate_limit/circuit_breaker)
// back to "retrying" and sends a summary notification.
// Validation/permanent errors are intentionally NOT auto-retried.
// ============================================================

import { retryDeadLetters, type DeadLetterCategory } from "../services/dead-letter.js";
import { emitEvent, EVENT_KEYS } from "../services/notification-events.js";

interface LoggerLike {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface DeadletterRetryDeps {
  logger: LoggerLike;
  /** Max dead letters to scan per category per run (default 50) */
  limit?: number;
}

export interface DeadletterRetrySummary {
  retried: number;
  failed: number;
  total: number;
}

/** Transient categories eligible for auto-retry — validation/permanent stay parked */
const RETRYABLE_CATEGORIES: DeadLetterCategory[] = ["api_error", "network", "rate_limit", "circuit_breaker"];

/**
 * Run one auto-retry pass over the dead letter queue.
 * retryDeadLetters() supports a single filterCategory, so loop the retryable set.
 */
export async function autoRetryDeadLetters(deps: DeadletterRetryDeps): Promise<DeadletterRetrySummary> {
  const { logger } = deps;
  const limit = deps.limit ?? 50;

  const summary: DeadletterRetrySummary = { retried: 0, failed: 0, total: 0 };
  for (const category of RETRYABLE_CATEGORIES) {
    const r = await retryDeadLetters({ filterCategory: category, limit });
    summary.retried += r.retried;
    summary.failed += r.failed;
    summary.total += r.total;
  }

  logger.info({ ...summary, categories: RETRYABLE_CATEGORIES }, "Dead letter auto-retry complete");

  if (summary.retried > 0 || summary.failed > 0) {
    await emitEvent(EVENT_KEYS.DEAD_LETTER_RETRY, {
      retried: String(summary.retried),
      failed: String(summary.failed),
      total: String(summary.total),
    }).catch(() => {});
  }

  return summary;
}
