// ============================================================
// Task Queue — In-memory + SQLite dual queue
// Merged into api-services per rules.md directory spec
// ============================================================

import type { DbAdapter } from "./connection.js";

// ---- Types ----

export type TaskType = "listing" | "ocr" | "translate" | "upload_image" | "create_draft" | "batch_listing";
export type TaskStatus = "queued" | "processing" | "done" | "failed";

export interface QueuedTask<T = Record<string, unknown>> {
  id: string;
  type: TaskType;
  status: TaskStatus;
  payload: T;
  correlationId: string;
  storeId: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  retryCount: number;
  maxRetries: number;
  priority: number;
}

export interface TaskQueueStats {
  queued: number;
  processing: number;
  done: number;
  failed: number;
  total: number;
}

type DbTaskRow = Record<string, unknown>;

// ---- Implementation ----

export class TaskQueue {
  private memoryQueue: Map<string, QueuedTask> = new Map();
  private processingSet: Set<string> = new Set();
  private db: DbAdapter | null = null;
  private dbAvailable = false;
  private initialized = false;

  constructor(db?: DbAdapter) {
    if (db) {
      this.db = db;
      this.dbAvailable = true;
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    if (this.dbAvailable && this.db) {
      try {
        // Schema is already created by db/schema.ts initSchema()
        const rows = await this.db.all(
          "SELECT * FROM task_queue WHERE status IN ('queued','processing') ORDER BY priority, created_at"
        );

        for (const row of rows) {
          this.memoryQueue.set(row.id as string, this.rowToTask(row));
          if (row.status === "processing") {
            this.processingSet.add(row.id as string);
          }
        }
      } catch {
        this.dbAvailable = false;
      }
    }

    this.initialized = true;
  }

  async enqueue(params: {
    type: TaskType;
    payload: Record<string, unknown>;
    correlationId: string;
    storeId?: string;
    id?: string;
    priority?: number;
    maxRetries?: number;
  }): Promise<QueuedTask> {
    await this.ensureInit();

    const task: QueuedTask = {
      id: params.id ?? crypto.randomUUID(),
      type: params.type,
      status: "queued",
      payload: params.payload,
      correlationId: params.correlationId,
      storeId: params.storeId ?? "store_1",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      retryCount: 0,
      maxRetries: params.maxRetries ?? 3,
      priority: params.priority ?? 0,
    };

    this.memoryQueue.set(task.id, task);

    if (this.dbAvailable && this.db) {
      await this.db.run(
        `INSERT OR REPLACE INTO task_queue (id, type, status, payload_json, correlation_id, store_id, priority, max_retries)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [task.id, task.type, task.status, JSON.stringify(task.payload), task.correlationId, task.storeId, task.priority, task.maxRetries]
      ).catch(() => {});
    }

    return task;
  }

  async dequeueBatch(count: number, type?: TaskType): Promise<QueuedTask[]> {
    await this.ensureInit();

    const candidates = Array.from(this.memoryQueue.values())
      .filter((t) => t.status === "queued" && (!type || t.type === type))
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))
      .slice(0, count);

    const now = new Date().toISOString();
    for (const task of candidates) {
      task.status = "processing";
      task.startedAt = now;
      this.processingSet.add(task.id);

      if (this.dbAvailable && this.db) {
        await this.db.run(
          "UPDATE task_queue SET status = 'processing', started_at = ? WHERE id = ?",
          [now, task.id]
        ).catch(() => {});
      }
    }

    return candidates;
  }

  async markProcessing(taskId: string): Promise<void> {
    await this.ensureInit();

    const task = this.memoryQueue.get(taskId);
    if (task) {
      task.status = "processing";
      task.startedAt = new Date().toISOString();
      this.processingSet.add(taskId);
    }

    if (this.dbAvailable && this.db) {
      await this.db.run(
        "UPDATE task_queue SET status = 'processing', started_at = ? WHERE id = ?",
        [new Date().toISOString(), taskId]
      ).catch(() => {});
    }
  }

  async markDone(taskId: string): Promise<void> {
    await this.ensureInit();

    const task = this.memoryQueue.get(taskId);
    if (task) {
      task.status = "done";
      task.completedAt = new Date().toISOString();
    }
    this.processingSet.delete(taskId);

    if (this.dbAvailable && this.db) {
      await this.db.run(
        "UPDATE task_queue SET status = 'done', completed_at = ? WHERE id = ?",
        [new Date().toISOString(), taskId]
      ).catch(() => {});
    }
  }

  async markFailed(taskId: string, errorMessage: string): Promise<void> {
    await this.ensureInit();

    const task = this.memoryQueue.get(taskId);
    if (task) {
      task.status = "failed";
      task.errorMessage = errorMessage;
      task.completedAt = new Date().toISOString();
    }
    this.processingSet.delete(taskId);

    if (this.dbAvailable && this.db) {
      await this.db.run(
        "UPDATE task_queue SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?",
        [errorMessage, new Date().toISOString(), taskId]
      ).catch(() => {});
    }
  }

  async retry(taskId: string): Promise<QueuedTask | null> {
    const task = this.memoryQueue.get(taskId);
    if (!task) return null;

    if (task.retryCount >= task.maxRetries) return null;

    task.status = "queued";
    task.retryCount++;
    task.errorMessage = null;
    task.startedAt = null;
    task.completedAt = null;

    if (this.dbAvailable && this.db) {
      await this.db.run(
        "UPDATE task_queue SET status = 'queued', retry_count = ?, error_message = NULL, started_at = NULL, completed_at = NULL WHERE id = ?",
        [task.retryCount, taskId]
      ).catch(() => {});
    }

    return task;
  }

  getTask(taskId: string): QueuedTask | undefined {
    return this.memoryQueue.get(taskId);
  }

  getStats(): TaskQueueStats {
    const all = Array.from(this.memoryQueue.values());
    return {
      queued: all.filter((t) => t.status === "queued").length,
      processing: all.filter((t) => t.status === "processing").length,
      done: all.filter((t) => t.status === "done").length,
      failed: all.filter((t) => t.status === "failed").length,
      total: all.length,
    };
  }

  listTasks(status?: TaskStatus, limit = 50): QueuedTask[] {
    let tasks = Array.from(this.memoryQueue.values());
    if (status) {
      tasks = tasks.filter((t) => t.status === status);
    }
    return tasks
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  prune(olderThanHours = 24): number {
    const cutoff = new Date(Date.now() - olderThanHours * 3600000).toISOString();
    let pruned = 0;

    for (const [id, task] of this.memoryQueue) {
      if (
        (task.status === "done" || task.status === "failed") &&
        task.completedAt &&
        task.completedAt < cutoff
      ) {
        this.memoryQueue.delete(id);
        pruned++;
      }
    }

    return pruned;
  }

  // ---- private ----

  private async ensureInit(): Promise<void> {
    if (!this.initialized) await this.init();
  }

  private rowToTask(row: DbTaskRow): QueuedTask {
    let payload: Record<string, unknown> = {};
    if (row.payload_json) {
      try {
        payload = JSON.parse(row.payload_json as string);
      } catch {
        console.warn(`[TaskQueue] Corrupted payload_json for task ${row.id}, skipping`);
      }
    }

    return {
      id: row.id as string,
      type: row.type as TaskType,
      status: row.status as TaskStatus,
      payload,
      correlationId: (row.correlation_id as string) ?? "",
      storeId: (row.store_id as string) ?? "store_1",
      createdAt: (row.created_at as string) ?? new Date().toISOString(),
      startedAt: (row.started_at as string) ?? null,
      completedAt: (row.completed_at as string) ?? null,
      errorMessage: (row.error_message as string) ?? null,
      retryCount: (row.retry_count as number) ?? 0,
      maxRetries: (row.max_retries as number) ?? 3,
      priority: (row.priority as number) ?? 0,
    };
  }
}
