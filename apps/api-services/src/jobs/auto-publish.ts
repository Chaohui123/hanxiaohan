// ============================================================
// Auto-Publish Queue Consumer — replaces n8n auto-publish workflow
// Drains queued "listing" tasks from TaskQueue and runs each through
// the shared listing pipeline (services/listing-runner.ts).
// Error grading (per dead-letter.ts categories):
//   - network/rate_limit/circuit_breaker/api_error → re-queue via taskQueue.retry
//     (until maxRetries exhausted, then dead letter)
//   - validation/compliance/CN-compliance blocks   → straight to dead letter
//   - ops-review rejection                         → markFailed only (policy, not failure)
// Anti-bot: random jitter between tasks (rules.md risk-control requirement).
// ============================================================

import type { TaskQueue, QueuedTask } from "../db/task-queue.js";
import { writeToDeadLetter, categorizeError, type DeadLetterCategory } from "../services/dead-letter.js";
import { emitEvent, EVENT_KEYS } from "../services/notification-events.js";
import { recordPipelineFailure, recordPipelineSuccess, type PipelineContext } from "../pipelines/listing-pipeline.js";
import { runListingPipeline, type ListingInfra } from "../services/listing-runner.js";

interface LoggerLike {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface AutoPublishDeps {
  taskQueue: TaskQueue;
  listingInfra: ListingInfra;
  batchSize: number;
  logger: LoggerLike;
  /** Anti-bot jitter between tasks — defaults to a random 0–15s sleep. Injectable for tests. */
  delayBetweenTasks?: () => Promise<void>;
}

export interface AutoPublishSummary {
  dequeued: number;
  succeeded: number;
  retried: number;
  failed: number;
  rejected: number;
}

/** Categories that justify a queue retry (transient failures) — mirrors deadletter-auto-retry filter */
const RETRYABLE_CATEGORIES: ReadonlySet<DeadLetterCategory> = new Set([
  "api_error", "network", "rate_limit", "circuit_breaker",
]);

/** Default anti-bot jitter: random 0–15s sleep between tasks (rules.md risk control) */
function defaultJitter(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 15_000)));
}

/**
 * Process one batch of queued "listing" tasks. Called by the auto-publish-queue
 * scheduled job. Returns a per-batch summary (also logged).
 */
export async function processListingBatch(deps: AutoPublishDeps): Promise<AutoPublishSummary> {
  const { taskQueue, listingInfra, batchSize, logger } = deps;
  const delay = deps.delayBetweenTasks ?? defaultJitter;

  const tasks = await taskQueue.dequeueBatch(batchSize, "listing");
  const summary: AutoPublishSummary = { dequeued: tasks.length, succeeded: 0, retried: 0, failed: 0, rejected: 0 };

  if (tasks.length === 0) {
    logger.info({ batchSize }, "Auto-publish: no queued listing tasks");
    return summary;
  }

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    await processOneTask(deps, task, summary);
    // Anti-bot jitter between tasks (not after the last one)
    if (i < tasks.length - 1) await delay();
  }

  logger.info({ ...summary }, "Auto-publish batch complete");
  return summary;
}

// ---- Internal ----

async function processOneTask(
  deps: AutoPublishDeps,
  task: QueuedTask,
  summary: Omit<AutoPublishSummary, "dequeued">
): Promise<void> {
  const { taskQueue, listingInfra, logger } = deps;
  const url = typeof task.payload?.url === "string" ? (task.payload.url as string) : null;

  if (!url) {
    summary.failed++;
    const reason = "Validation: listing task payload missing 'url'";
    logger.error({ taskId: task.id, payload: task.payload }, "Auto-publish: invalid task payload");
    await taskQueue.markFailed(task.id, reason);
    await writeToDeadLetter({
      taskType: "listing", errorMessage: reason,
      payload: task.payload as Record<string, unknown>, storeId: task.storeId, correlationId: task.correlationId,
    }).catch(() => {});
    await notifyFailure(task, url ?? "(missing url)", reason);
    return;
  }

  let ctx: PipelineContext | null = null;
  try {
    const result = await runListingPipeline(listingInfra, {
      url, storeId: task.storeId, correlationId: task.correlationId,
    });
    ctx = result.ctx;
    const { outcome } = result;

    if (outcome.kind === "success") {
      summary.succeeded++;
      await taskQueue.markDone(task.id);
      recordPipelineSuccess(ctx).catch((err) =>
        logger.warn({ taskId: task.id, err: (err as Error).message }, "Auto-publish: failed to record success")
      );
      logger.info({ taskId: task.id, productId: outcome.productId, offerId: outcome.offerId }, "Auto-publish: listing created");
      return;
    }

    if (outcome.kind === "blocked") {
      if (outcome.blockKind === "ops_review") {
        // Policy rejection — not a failure, no dead letter
        summary.rejected++;
        await taskQueue.markFailed(task.id, `Ops review rejected: ${outcome.reason}`);
        logger.warn({ taskId: task.id, reason: outcome.reason }, "Auto-publish: ops review rejected");
        return;
      }
      // Validation/compliance blocks go straight to dead letter (not retryable)
      summary.failed++;
      await taskQueue.markFailed(task.id, outcome.reason);
      await writeToDeadLetter({
        taskType: "listing", errorMessage: outcome.reason,
        payload: { url }, storeId: task.storeId, correlationId: task.correlationId,
      }).catch(() => {});
      if (outcome.blockKind === "cn_compliance") {
        recordPipelineFailure(ctx, new Error(outcome.reason)).catch(() => {});
      }
      await notifyFailure(task, url, outcome.reason);
      return;
    }

    // outcome.kind === "error" — grade by category
    await handlePipelineError(deps, task, url, ctx, outcome.error, summary);
  } catch (err) {
    // Runner never throws by contract — defensive fallback for unexpected bugs
    await handlePipelineError(deps, task, url, ctx, err instanceof Error ? err : new Error(String(err)), summary);
  }
}

async function handlePipelineError(
  deps: AutoPublishDeps,
  task: QueuedTask,
  url: string,
  ctx: PipelineContext | null,
  error: Error,
  summary: Omit<AutoPublishSummary, "dequeued">
): Promise<void> {
  const { taskQueue, logger } = deps;
  const category = categorizeError(error.message);

  if (RETRYABLE_CATEGORIES.has(category)) {
    // Transient — re-queue for a later cycle (until maxRetries exhausted)
    const requeued = await taskQueue.retry(task.id);
    if (requeued) {
      summary.retried++;
      logger.warn({
        taskId: task.id, category, retryCount: requeued.retryCount, maxRetries: requeued.maxRetries, err: error.message,
      }, "Auto-publish: transient failure — task re-queued");
      return;
    }
    logger.error({ taskId: task.id, category, err: error.message }, "Auto-publish: retries exhausted — sending to dead letter");
  }

  // Non-retryable or retries exhausted → terminal failure
  summary.failed++;
  await taskQueue.markFailed(task.id, error.message);
  await writeToDeadLetter({
    taskType: "listing", errorMessage: error.message,
    payload: { url }, storeId: task.storeId, correlationId: task.correlationId,
  }).catch(() => {});
  if (ctx) {
    recordPipelineFailure(ctx, error).catch((err) =>
      logger.warn({ taskId: task.id, err: (err as Error).message }, "Auto-publish: failed to record pipeline failure")
    );
  }
  await notifyFailure(task, url, error.message);
}

async function notifyFailure(task: QueuedTask, url: string, error: string): Promise<void> {
  await emitEvent(EVENT_KEYS.LISTING_FAILED, {
    title: url.length > 80 ? `...${url.slice(-77)}` : url,
    error: error.slice(0, 200),
  }, task.correlationId).catch(() => {});
}
