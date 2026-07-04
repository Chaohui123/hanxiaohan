// ============================================================
// Async Queue — unified concurrency-limited task processing
// Used by: COS upload, FFmpeg transcoding, dead-letter retries
// Prevents resource exhaustion (bandwidth, CPU, memory)
// ============================================================

import { logger } from "@onzo/logger";

export interface QueueTask<T = unknown> {
  id: string;
  type: string;
  data: T;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
}

export interface QueueResult {
  taskId: string;
  success: boolean;
  error?: string;
}

type TaskHandler<T> = (task: QueueTask<T>) => Promise<void>;

export class AsyncQueue<T = unknown> {
  private queue: QueueTask<T>[] = [];
  private activeCount = 0;
  private handlers = new Map<string, TaskHandler<T>>();
  private onTaskFailed?: (task: QueueTask<T>, error: string) => Promise<void>;

  constructor(
    private name: string,
    private maxConcurrency: number = 3,
    private maxRetries: number = 3,
  ) {}

  /** Register a handler for a task type */
  registerHandler(type: string, handler: TaskHandler<T>): void {
    this.handlers.set(type, handler);
  }

  /** Called when a task exhausts all retries */
  onFailed(handler: (task: QueueTask<T>, error: string) => Promise<void>): void {
    this.onTaskFailed = handler;
  }

  /** Enqueue a task for async processing */
  async enqueue(type: string, data: T, options?: { maxRetries?: number }): Promise<string> {
    const task: QueueTask<T> = {
      id: `${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      data,
      retryCount: 0,
      maxRetries: options?.maxRetries ?? this.maxRetries,
      createdAt: Date.now(),
    };

    this.queue.push(task);
    logger.debug({ queue: this.name, taskId: task.id, type, queueSize: this.queue.length }, "Task enqueued");

    // Trigger processing (non-blocking)
    this.processNext();

    return task.id;
  }

  /** Get current queue stats */
  getStats() {
    return {
      name: this.name,
      queued: this.queue.length,
      active: this.activeCount,
      maxConcurrency: this.maxConcurrency,
    };
  }

  /** Process next items in queue if concurrency allows */
  private processNext(): void {
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.activeCount++;
      this.executeTask(task);
    }
  }

  private async executeTask(task: QueueTask<T>): Promise<void> {
    const handler = this.handlers.get(task.type);
    if (!handler) {
      logger.error({ queue: this.name, taskId: task.id, type: task.type }, "No handler registered for task type");
      this.activeCount--;
      this.processNext();
      return;
    }

    try {
      await handler(task);
      logger.debug({ queue: this.name, taskId: task.id, type: task.type }, "Task completed");
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.warn({ queue: this.name, taskId: task.id, type: task.type, retry: task.retryCount, err: errorMsg }, "Task failed");

      if (task.retryCount < task.maxRetries) {
        task.retryCount++;
        const delay = Math.min(1000 * Math.pow(2, task.retryCount), 30000);
        logger.info({ queue: this.name, taskId: task.id, delay, nextRetry: task.retryCount }, "Retrying task");
        setTimeout(() => {
          this.queue.push(task);
          this.processNext();
        }, delay);
      } else {
        logger.error({ queue: this.name, taskId: task.id, type: task.type }, "Task exhausted all retries — sending to dead letter");
        await this.onTaskFailed?.(task, errorMsg);
      }
    } finally {
      this.activeCount--;
      this.processNext();
    }
  }
}

// ---- Global singleton queues ----

/** COS image upload queue — max 5 concurrent uploads */
export const cosUploadQueue = new AsyncQueue<{
  filePath: string;
  productId: string;
  key?: string;
}>("cos-upload", 5, 2);

/** FFmpeg video transcode queue — max 1 concurrent to avoid CPU exhaustion */
export const ffmpegQueue = new AsyncQueue<{
  inputPath: string;
  voiceoverPath: string;
  srtPath: string;
  outputDir: string;
  productName: string;
}>("ffmpeg", 1, 1);

/** Dead letter retry queue — max 3 concurrent retries */
export const deadLetterQueue = new AsyncQueue<{
  taskId: string;
  taskType: string;
  payload: Record<string, unknown>;
  errorMessage: string;
  storeId: string;
}>("dead-letter", 3, 3);
