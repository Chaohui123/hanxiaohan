// ============================================================
// BullMQ Queue — Redis-backed async task queue
// Replaces in-memory TaskQueue when Redis is available.
// Falls back to existing TaskQueue in standalone/SQLite mode.
// ============================================================

import { logger } from "@onzo/logger";

export enum JobName {
  DASHBOARD_ANALYSIS = "dashboard-analysis",
  KEYWORD_SCRAPE = "keyword-scrape",
  PRODUCT_LISTING = "product-listing",
  PRODUCT_SCORE = "product-score",
  IMAGE_PREPROCESS = "image-preprocess",
  OZON_PUBLISH = "ozon-publish",
  DASHBOARD_REPORT = "dashboard-report",
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bullmqMod: any = null;
let redisAvailable = false;

async function loadBullMQ() {
  if (bullmqMod) return bullmqMod;
  try {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error("REDIS_URL not configured");

    // Test Redis connectivity via ioredis
    const RedisModule = await import("ioredis");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Redis = (RedisModule as any).default || RedisModule;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const testRedis = new (Redis as any)(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await (testRedis as Record<string, () => Promise<unknown>>).connect?.();
    await (testRedis as Record<string, () => Promise<unknown>>).ping?.();
    (testRedis as Record<string, () => void>).disconnect?.();

    bullmqMod = await import("bullmq");
    redisAvailable = true;
    logger.info("BullMQ initialized — Redis-backed task queue active");
    return bullmqMod;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "BullMQ unavailable — falling back to in-memory TaskQueue");
    redisAvailable = false;
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queues = new Map<string, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const workers = new Map<string, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fallbackTaskQueue: any = null;

export function setFallbackQueue(queue: unknown): void {
  fallbackTaskQueue = queue;
}

export function isRedisQueueAvailable(): boolean {
  return redisAvailable;
}

/** Get or create a BullMQ queue (or fallback wrapper) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getQueue(name: string): Promise<any> {
  const bullmq = await loadBullMQ();
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

  if (!bullmq || !redisAvailable) {
    return createFallbackQueue(name);
  }

  if (queues.has(name)) return queues.get(name);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = { url: redisUrl } as any;
  const queue = new bullmq.Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: parseInt(process.env.BULLMQ_RETRY_MAX || "3", 10),
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
    },
  });
  queues.set(name, queue);
  logger.info({ queue: name }, "BullMQ queue created");
  return queue;
}

/** Register a worker for a queue with concurrency */
export async function registerWorker(
  queueName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processor: (job: any) => Promise<void>,
  concurrency = 3,
): Promise<void> {
  const bullmq = await loadBullMQ();
  if (!bullmq || !redisAvailable) return;

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const workerKey = `${queueName}:worker`;
  if (workers.has(workerKey)) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = { url: redisUrl } as any;
  const worker = new bullmq.Worker(queueName, processor, {
    connection,
    concurrency,
    autorun: true,
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });

  worker.on("completed", (job: { id: string }) => {
    logger.info({ queue: queueName, jobId: job.id }, "BullMQ job completed");
  });
  worker.on("failed", (job: { id: string } | undefined, err: Error) => {
    logger.warn({ queue: queueName, jobId: job?.id, err: err.message }, "BullMQ job failed");
  });

  workers.set(workerKey, worker);
  logger.info({ queue: queueName, workerKey, concurrency }, "BullMQ worker registered");
}

/** Shut down all queues and workers gracefully */
export async function shutdownAll(): Promise<void> {
  for (const worker of workers.values()) {
    try { await worker.close(); } catch { /* ok */ }
  }
  for (const queue of queues.values()) {
    try { await queue.close(); } catch { /* ok */ }
  }
  workers.clear();
  queues.clear();
  logger.info("BullMQ queues and workers shut down");
}

// ---- Fallback (no Redis) ----

function createFallbackQueue(name: string) {
  return {
    add: async (jobName: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (!fallbackTaskQueue) throw new Error(`BullMQ unavailable and no fallback queue set for: ${name}`);
      const task = await fallbackTaskQueue.enqueue({
        type: `bullmq_${jobName}` as never,
        payload: data,
        correlationId: `bullmq_${name}_${Date.now()}`,
        priority: (opts as Record<string, number>)?.priority ?? 0,
      });
      logger.info({ queue: name, jobName, taskId: task.id }, "Fallback task enqueued (in-memory mode)");
      return { id: task.id };
    },
    getStats: async () => ({ waiting: fallbackTaskQueue?.getStats?.().queued ?? 0 }),
    close: async () => {},
  };
}
