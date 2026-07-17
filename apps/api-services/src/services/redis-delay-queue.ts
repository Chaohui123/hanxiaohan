// ============================================================
// Redis Delay Queue — replaces Ozon import task_id polling
// Uses Redis Sorted Set for scheduled task execution.
// Consumer runs in background, pops due tasks and processes them.
// ============================================================

import { cache } from "@onzo/cache";
import { logger } from "@onzo/logger";

const QUEUE_KEY = "onzo:queue:ozon-tasks";
const PROCESSING_KEY = "onzo:queue:ozon-tasks:processing";

export interface DelayTask {
  id: string;
  type: "ozon_import_check" | "draft_status" | "product_info";
  payload: Record<string, unknown>;
  executeAt: number; // epoch ms
}

// ---- Producer ----

/** Enqueue a delayed task. executeAt: epoch ms when the task should fire. */
export async function enqueueDelayTask(task: DelayTask): Promise<void> {
  await cache.zadd(QUEUE_KEY, task.executeAt, JSON.stringify(task));
  logger.debug({ taskId: task.id, type: task.type, executeAt: new Date(task.executeAt).toISOString() }, "DelayQueue: enqueued");
}

/** Get queue depth */
export async function queueDepth(): Promise<number> {
  return cache.zcard(QUEUE_KEY);
}

// ---- Consumer ----

let consumerTimer: ReturnType<typeof setInterval> | null = null;

/** Start the delay queue consumer. Polls every 5 seconds for due tasks. */
export function startDelayQueueConsumer(handler: (task: DelayTask) => Promise<void>): void {
  if (consumerTimer) return;

  logger.info("DelayQueue: consumer started (polling every 5s)");
  consumerTimer = setInterval(async () => {
    try {
      const now = Date.now();
      // Pop up to 10 due tasks (score <= now)
      const tasks = await cache.zpopmin(QUEUE_KEY, 10);

      for (const { member } of tasks) {
        try {
          const task = JSON.parse(member) as DelayTask;
          // Move to processing set for tracking
          await cache.set(`${PROCESSING_KEY}:${task.id}`, "1", 300);

          logger.debug({ taskId: task.id, type: task.type }, "DelayQueue: processing");
          await handler(task);

          await cache.del(`${PROCESSING_KEY}:${task.id}`);
        } catch (err) {
          logger.error({ err: (err as Error).message, member: member.slice(0, 200) }, "DelayQueue: task failed");
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "DelayQueue: poll error");
    }
  }, 5000);
}

/** Stop the consumer */
export function stopDelayQueueConsumer(): void {
  if (consumerTimer) {
    clearInterval(consumerTimer);
    consumerTimer = null;
    logger.info("DelayQueue: consumer stopped");
  }
}