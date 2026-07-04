// ============================================================
// Dead Letter Queue — centralized retry + permanent failure storage
// Automatically captures failed API calls, DB writes, and pipeline errors
// ============================================================

import { randomUUID } from "node:crypto";
import { getDb, serializedWrite } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { notifier } from "./notifier.js";

export type DeadLetterStatus = "pending_retry" | "retrying" | "permanent_failure" | "retried";
export type DeadLetterCategory = "api_error" | "validation" | "network" | "rate_limit" | "circuit_breaker" | "unknown";

export interface DeadLetterEntry {
  id: string;
  taskType: string;
  category: DeadLetterCategory;
  payload: Record<string, unknown>;
  errorMessage: string;
  status: DeadLetterStatus;
  storeId: string;
  retryCount: number;
  maxRetries: number;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Write a failed task to the dead letter queue.
 * Auto-categorizes the error type for smart retry filtering.
 */
export async function writeToDeadLetter(params: {
  taskType: string;
  errorMessage: string;
  payload?: Record<string, unknown>;
  storeId?: string;
  correlationId?: string;
  maxRetries?: number;
}): Promise<string> {
  const id = randomUUID();
  const db = await getDb().catch(() => null);
  if (!db) {
    logger.error("Dead letter: DB unavailable, cannot persist failure");
    return id;
  }

  const category = categorizeError(params.errorMessage);
  const storeId = params.storeId ?? "store_1";
  const correlationId = params.correlationId ?? "";

  await serializedWrite(() =>
    db.run(
      `INSERT OR REPLACE INTO failed_tasks (id, store_id, task_type, payload_json, error_message, status, correlation_id, retry_count, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending_retry', ?, 0, datetime('now'))`,
      [
        id,
        storeId,
        params.taskType,
        JSON.stringify(params.payload ?? {}),
        `${category}:${params.errorMessage}`,
        correlationId,
      ]
    )
  ).catch((err) => {
    logger.error({ err }, "Dead letter: Failed to persist to DB");
  });

  // Notify on permanent failures
  if ((params.maxRetries ?? 3) >= 3) {
    await notifier
      .notify({
        level: "error",
        event: "死信队列",
        message: `[${category}] ${params.taskType}: ${params.errorMessage.substring(0, 200)}`,
        correlationId,
        metadata: {
          taskType: params.taskType,
          category,
          error: params.errorMessage.substring(0, 100),
        },
      })
      .catch(() => {});
  }

  return id;
}

/**
 * Retry all pending dead letter tasks (filtered by category).
 */
export async function retryDeadLetters(options?: {
  filterCategory?: DeadLetterCategory;
  storeId?: string;
  limit?: number;
}): Promise<{ retried: number; failed: number; total: number }> {
  const db = await getDb().catch(() => null);
  if (!db) return { retried: 0, failed: 0, total: 0 };

  const storeId = options?.storeId ?? "store_1";
  const limit = options?.limit ?? 50;

  const rows = (await db.all(
    `SELECT * FROM failed_tasks WHERE store_id = ? AND status = 'pending_retry' ORDER BY created_at ASC LIMIT ?`,
    [storeId, limit]
  )) as Record<string, unknown>[];

  let retried = 0;
  let failed = 0;

  for (const row of rows) {
    const id = row.id as string;
    const errorMsg = (row.error_message as string) || "";
    const category = errorMsg.split(":")[0] as DeadLetterCategory;

    if (options?.filterCategory && category !== options.filterCategory) continue;

    try {
      await db.run(
        "UPDATE failed_tasks SET status = 'retrying', retry_count = retry_count + 1, updated_at = datetime('now') WHERE id = ?",
        [id]
      );
      retried++;
    } catch {
      await db
        .run("UPDATE failed_tasks SET status = 'permanent_failure', updated_at = datetime('now') WHERE id = ?", [id])
        .catch(() => {});
      failed++;
    }
  }

  logger.info({ retried, failed, total: rows.length }, "Dead letter retry batch complete");
  return { retried, failed, total: rows.length };
}

/**
 * Categorize error message into DeadLetterCategory for smart filtering.
 */
function categorizeError(msg: string): DeadLetterCategory {
  const lower = msg.toLowerCase();
  if (lower.includes("validation") || lower.includes("invalid") || lower.includes("missing")) return "validation";
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many")) return "rate_limit";
  if (lower.includes("circuit breaker") || lower.includes("breaker open")) return "circuit_breaker";
  if (lower.includes("fetch failed") || lower.includes("network") || lower.includes("econnrefused") || lower.includes("timeout")) return "network";
  if (lower.includes("ozon api error") || lower.includes("5xx") || lower.includes("500") || lower.includes("502") || lower.includes("503")) return "api_error";
  return "unknown";
}
