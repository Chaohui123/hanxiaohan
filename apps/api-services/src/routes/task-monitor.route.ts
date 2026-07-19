// ============================================================
// Task Monitor Routes — queue stats, task list, dead-letter retry, listings
// Data sources: task_queue / failed_tasks / listing_records tables + TaskQueue
// ============================================================

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { logger } from "@onzo/logger";
import { getDb, serializedWrite } from "../db/connection.js";
import type { TaskQueue, TaskQueueStats, TaskStatus } from "../db/task-queue.js";
import {
  retryDeadLetters,
  writeToDeadLetter,
  type DeadLetterCategory,
  type DeadLetterStatus,
} from "../services/dead-letter.js";

// failed_tasks has no max_retries column — expose the system-wide default
// (same fallback as writeToDeadLetter / TaskQueue).
const DEFAULT_MAX_RETRIES = 3;

const DEAD_LETTER_CATEGORIES: readonly DeadLetterCategory[] = [
  "api_error",
  "validation",
  "network",
  "rate_limit",
  "circuit_breaker",
  "unknown",
];

// ---- Zod schemas ----

const QueueQuerySchema = z.object({
  status: z.enum(["all", "queued", "processing", "done", "failed"]).optional().default("all"),
  storeId: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
});

const FailedQuerySchema = z.object({
  storeId: z.string().min(1).optional(),
  status: z
    .enum(["actionable", "pending_retry", "retrying", "permanent_failure", "retried", "all"])
    .optional()
    .default("actionable"),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
});

const ListingsQuerySchema = z.object({
  status: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(20),
});

const RetryBatchSchema = z
  .object({
    taskIds: z.array(z.string().min(1)).max(200).optional(),
    filterType: z
      .enum(["all", "all_retryable", "api_error", "validation", "network", "rate_limit", "circuit_breaker", "unknown"])
      .optional()
      .default("all"),
    storeId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional().default(50),
  })
  // prefault: parse the fallback through the schema so inner defaults apply (zod 4 semantics)
  .prefault({});

const FailedNotifySchema = z.object({
  error: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  source: z.string().min(1).optional(),
  taskType: z.string().min(1).optional(),
  storeId: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const TaskIdParamSchema = z.string().min(1);

// ---- DTO types ----

interface TaskDto {
  id: string;
  type: string;
  status: string;
  storeId: string;
  correlationId: string;
  payload: Record<string, unknown>;
  errorMessage: string | null;
  retryCount: number;
  maxRetries: number;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** Dual-casing DTO: web Dashboard uses camelCase, ops HTML/FailedProducts use snake_case. */
interface FailedTaskDto {
  id: string;
  taskType: string;
  task_type: string;
  storeId: string;
  store_id: string;
  status: string;
  category: DeadLetterCategory;
  errorMessage: string;
  error_message: string;
  retryCount: number;
  retry_count: number;
  maxRetries: number;
  payload: Record<string, unknown>;
  correlationId: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
}

interface ListingDto {
  id: string;
  sourceUrl: string | null;
  status: string;
  draftId: string | null;
  ozonProductId: number | null;
  correlationId: string;
  createdAt: string;
}

interface QueueStatsDto extends TaskQueueStats {
  deadLetterPending: number;
}

// ---- Row mappers ----

type DbRow = Record<string, unknown>;

function parsePayload(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToTaskDto(row: DbRow): TaskDto {
  return {
    id: String(row.id ?? ""),
    type: String(row.type ?? ""),
    status: String(row.status ?? ""),
    storeId: String(row.store_id ?? "store_1"),
    correlationId: String(row.correlation_id ?? ""),
    payload: parsePayload(row.payload_json),
    errorMessage: row.error_message != null ? String(row.error_message) : null,
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? DEFAULT_MAX_RETRIES),
    priority: Number(row.priority ?? 0),
    createdAt: String(row.created_at ?? ""),
    startedAt: row.started_at != null ? String(row.started_at) : null,
    completedAt: row.completed_at != null ? String(row.completed_at) : null,
  };
}

function parseCategory(errorMessage: string): DeadLetterCategory {
  const prefix = errorMessage.split(":")[0] ?? "";
  return (DEAD_LETTER_CATEGORIES as readonly string[]).includes(prefix)
    ? (prefix as DeadLetterCategory)
    : "unknown";
}

function rowToFailedTaskDto(row: DbRow): FailedTaskDto {
  const taskType = String(row.task_type ?? "");
  const storeId = String(row.store_id ?? "");
  const errorMessage = String(row.error_message ?? "");
  const retryCount = Number(row.retry_count ?? 0);
  const createdAt = String(row.created_at ?? "");
  const updatedAt = String(row.updated_at ?? "");
  return {
    id: String(row.id ?? ""),
    taskType,
    task_type: taskType,
    storeId,
    store_id: storeId,
    status: String(row.status ?? "pending_retry"),
    category: parseCategory(errorMessage),
    errorMessage,
    error_message: errorMessage,
    retryCount,
    retry_count: retryCount,
    maxRetries: DEFAULT_MAX_RETRIES,
    payload: parsePayload(row.payload_json),
    correlationId: String(row.correlation_id ?? ""),
    createdAt,
    created_at: createdAt,
    updatedAt,
    updated_at: updatedAt,
  };
}

function rowToListingDto(row: DbRow): ListingDto {
  return {
    id: String(row.id ?? ""),
    sourceUrl: row.source_url != null ? String(row.source_url) : null,
    status: String(row.status ?? ""),
    draftId: row.draft_id != null ? String(row.draft_id) : null,
    ozonProductId: row.ozon_product_id != null ? Number(row.ozon_product_id) : null,
    correlationId: String(row.correlation_id ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

// ---- Router ----

export function createTaskMonitorRouter(taskQueue: TaskQueue): Router {
  const router = Router();

  function memoryStats(): TaskQueueStats {
    try {
      return taskQueue.getStats();
    } catch {
      return { queued: 0, processing: 0, done: 0, failed: 0, total: 0, activeWorkers: 0, maxConcurrency: 0 };
    }
  }

  function validationError(res: Response, req: Request, issues: string): void {
    res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: issues, retryable: false },
      correlationId: req.correlationId,
    });
  }

  function serverError(res: Response, req: Request, code: string, err: unknown): void {
    logger.error({ err: (err as Error).message, code, correlationId: req.correlationId }, "Task monitor endpoint failed");
    res.status(500).json({
      success: false,
      error: { code, message: (err as Error).message },
      correlationId: req.correlationId,
    });
  }

  /** GET /queue/stats — queue statistics (DB-backed, memory fallback) */
  router.get("/queue/stats", async (req, res) => {
    try {
      const memory = memoryStats();
      const stats: QueueStatsDto = { ...memory, deadLetterPending: 0 };

      const db = await getDb().catch(() => null);
      if (db) {
        const rows = (await db.all("SELECT status, COUNT(*) as cnt FROM task_queue GROUP BY status")) as Array<{
          status: string;
          cnt: number;
        }>;
        const byStatus = new Map(rows.map((r) => [r.status, Number(r.cnt)]));
        stats.queued = byStatus.get("queued") ?? 0;
        stats.processing = byStatus.get("processing") ?? 0;
        stats.done = byStatus.get("done") ?? 0;
        stats.failed = byStatus.get("failed") ?? 0;
        stats.total = rows.reduce((sum, r) => sum + Number(r.cnt), 0);

        const dl = (await db.all("SELECT COUNT(*) as cnt FROM failed_tasks WHERE status = 'pending_retry'")) as Array<{
          cnt: number;
        }>;
        stats.deadLetterPending = Number(dl[0]?.cnt ?? 0);
      }

      res.json({ success: true, data: stats, correlationId: req.correlationId });
    } catch (err) {
      serverError(res, req, "QUEUE_STATS_ERROR", err);
    }
  });

  /** GET /queue — list tasks with optional status/storeId/type filters */
  router.get("/queue", async (req, res) => {
    const parsed = QueueQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      validationError(res, req, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
      return;
    }

    try {
      const { status, storeId, type, limit } = parsed.data;
      const db = await getDb().catch(() => null);

      let data: TaskDto[];
      if (db) {
        const conditions: string[] = [];
        const params: unknown[] = [];
        if (status !== "all") {
          conditions.push("status = ?");
          params.push(status);
        }
        if (storeId) {
          conditions.push("store_id = ?");
          params.push(storeId);
        }
        if (type) {
          conditions.push("type = ?");
          params.push(type);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const rows = (await db.all(
          `SELECT * FROM task_queue ${where} ORDER BY created_at DESC LIMIT ?`,
          [...params, limit]
        )) as DbRow[];
        data = rows.map(rowToTaskDto);
      } else {
        // In-memory fallback (standalone mode without DB)
        const memoryStatus: TaskStatus | undefined = status === "all" ? undefined : status;
        data = taskQueue
          .listTasks(memoryStatus, limit)
          .filter((t) => !storeId || t.storeId === storeId)
          .filter((t) => !type || t.type === type)
          .map((t) => ({
            id: t.id,
            type: t.type,
            status: t.status,
            storeId: t.storeId,
            correlationId: t.correlationId,
            payload: t.payload,
            errorMessage: t.errorMessage,
            retryCount: t.retryCount,
            maxRetries: t.maxRetries,
            priority: t.priority,
            createdAt: t.createdAt,
            startedAt: t.startedAt,
            completedAt: t.completedAt,
          }));
      }

      res.json({ success: true, data, count: data.length, correlationId: req.correlationId });
    } catch (err) {
      serverError(res, req, "QUEUE_LIST_ERROR", err);
    }
  });

  /** GET /failed — list dead-letter tasks (default: actionable, i.e. not yet retried) */
  router.get("/failed", async (req, res) => {
    const parsed = FailedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      validationError(res, req, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
      return;
    }

    try {
      const { storeId, status, limit } = parsed.data;
      const db = await getDb().catch(() => null);
      if (!db) {
        res.json({ success: true, data: [], count: 0, correlationId: req.correlationId });
        return;
      }

      const conditions: string[] = [];
      const params: unknown[] = [];
      if (status === "actionable") {
        conditions.push("status != 'retried'");
      } else if (status !== "all") {
        conditions.push("status = ?");
        params.push(status satisfies DeadLetterStatus);
      }
      if (storeId) {
        conditions.push("store_id = ?");
        params.push(storeId);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const rows = (await db.all(
        `SELECT * FROM failed_tasks ${where} ORDER BY created_at DESC LIMIT ?`,
        [...params, limit]
      )) as DbRow[];

      const data = rows.map(rowToFailedTaskDto);
      res.json({ success: true, data, count: data.length, correlationId: req.correlationId });
    } catch (err) {
      serverError(res, req, "FAILED_LIST_ERROR", err);
    }
  });

  /** POST /failed — external failure notification (n8n auto-publish) → dead letter */
  router.post("/failed", async (req, res) => {
    const parsed = FailedNotifySchema.safeParse(req.body);
    if (!parsed.success) {
      validationError(res, req, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
      return;
    }

    try {
      const { error, source, taskType, storeId, payload } = parsed.data;
      const errorMessage =
        typeof error === "string"
          ? error
          : typeof error.message === "string"
            ? error.message
            : JSON.stringify(error);

      const id = await writeToDeadLetter({
        taskType: taskType ?? source ?? "external_notification",
        errorMessage,
        payload: { error, source: source ?? "unknown", ...(payload ?? {}) },
        storeId,
        correlationId: req.correlationId,
      });

      logger.info({ id, taskType: taskType ?? source, correlationId: req.correlationId }, "External failure recorded to dead letter");
      res.status(201).json({ success: true, data: { id }, correlationId: req.correlationId });
    } catch (err) {
      serverError(res, req, "FAILED_NOTIFY_ERROR", err);
    }
  });

  /** POST /retry/:id — re-queue a single task (task_queue or failed_tasks) */
  router.post("/retry/:id", async (req, res) => {
    const parsed = TaskIdParamSchema.safeParse(req.params.id);
    if (!parsed.success) {
      validationError(res, req, "id: must be a non-empty string");
      return;
    }
    const id = parsed.data;

    try {
      // 1) In-memory queue (covers tasks enqueued this session)
      const memoryTask = taskQueue.getTask(id);
      if (memoryTask) {
        const retried = await taskQueue.retry(id);
        if (retried) {
          logger.info({ id, retryCount: retried.retryCount, correlationId: req.correlationId }, "Task re-queued (memory)");
          res.json({
            success: true,
            data: { id, source: "task_queue", status: retried.status, retryCount: retried.retryCount },
            correlationId: req.correlationId,
          });
          return;
        }
        res.status(400).json({
          success: false,
          error: { code: "TASK_NOT_RETRYABLE", message: `Task ${id} exceeded max retries`, retryable: false },
          correlationId: req.correlationId,
        });
        return;
      }

      // 2) DB fallback — task_queue first, then failed_tasks
      const db = await getDb().catch(() => null);
      if (db) {
        const tqRows = (await db.all("SELECT id, status, retry_count FROM task_queue WHERE id = ?", [id])) as DbRow[];
        if (tqRows.length > 0) {
          const row = tqRows[0];
          if (row.status === "done") {
            res.status(400).json({
              success: false,
              error: { code: "TASK_NOT_RETRYABLE", message: `Task ${id} is already done`, retryable: false },
              correlationId: req.correlationId,
            });
            return;
          }
          await serializedWrite(() =>
            db.run(
              "UPDATE task_queue SET status = 'queued', retry_count = retry_count + 1, error_message = NULL, started_at = NULL, completed_at = NULL WHERE id = ?",
              [id]
            )
          );
          const retryCount = Number(row.retry_count ?? 0) + 1;
          logger.info({ id, retryCount, correlationId: req.correlationId }, "Task re-queued (db)");
          res.json({
            success: true,
            data: { id, source: "task_queue", status: "queued", retryCount },
            correlationId: req.correlationId,
          });
          return;
        }

        const ftRows = (await db.all("SELECT id, retry_count FROM failed_tasks WHERE id = ?", [id])) as DbRow[];
        if (ftRows.length > 0) {
          await serializedWrite(() =>
            db.run(
              "UPDATE failed_tasks SET status = 'pending_retry', retry_count = retry_count + 1, updated_at = NOW() WHERE id = ?",
              [id]
            )
          );
          const retryCount = Number(ftRows[0].retry_count ?? 0) + 1;
          logger.info({ id, retryCount, correlationId: req.correlationId }, "Dead letter marked for retry");
          res.json({
            success: true,
            data: { id, source: "dead_letter", status: "pending_retry", retryCount },
            correlationId: req.correlationId,
          });
          return;
        }
      }

      res.status(404).json({
        success: false,
        error: { code: "TASK_NOT_FOUND", message: `Task ${id} not found`, retryable: false },
        correlationId: req.correlationId,
      });
    } catch (err) {
      serverError(res, req, "TASK_RETRY_ERROR", err);
    }
  });

  /** POST /deadletter/retry-batch — batch retry dead letters (all / by category / by ids) */
  router.post("/deadletter/retry-batch", async (req, res) => {
    const parsed = RetryBatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      validationError(res, req, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
      return;
    }

    try {
      const { taskIds, filterType, storeId, limit } = parsed.data;

      if (taskIds && taskIds.length > 0) {
        const db = await getDb().catch(() => null);
        if (!db) {
          res.status(503).json({
            success: false,
            error: { code: "DB_UNAVAILABLE", message: "Database unavailable", retryable: true },
            correlationId: req.correlationId,
          });
          return;
        }
        let retried = 0;
        let failed = 0;
        for (const id of taskIds) {
          const result = await serializedWrite(() =>
            db.run(
              "UPDATE failed_tasks SET status = 'retrying', retry_count = retry_count + 1, updated_at = NOW() WHERE id = ? AND status IN ('pending_retry', 'permanent_failure')",
              [id]
            )
          );
          if (result.changes > 0) retried++;
          else failed++;
        }
        logger.info({ retried, failed, total: taskIds.length, correlationId: req.correlationId }, "Dead letter batch retry by ids");
        res.json({ success: true, data: { retried, failed, total: taskIds.length }, correlationId: req.correlationId });
        return;
      }

      const filterCategory: DeadLetterCategory | undefined =
        filterType === "all" || filterType === "all_retryable" ? undefined : filterType;
      const data = await retryDeadLetters({ filterCategory, storeId, limit });
      res.json({ success: true, data, correlationId: req.correlationId });
    } catch (err) {
      serverError(res, req, "DEADLETTER_RETRY_ERROR", err);
    }
  });

  /** GET|POST /listings — listing history (POST kept for n8n auto-publish workflow) */
  const listingsHandler = async (req: Request, res: Response): Promise<void> => {
    const parsed = ListingsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      validationError(res, req, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
      return;
    }

    try {
      const { status, limit } = parsed.data;
      const db = await getDb().catch(() => null);

      let rows: DbRow[] = [];
      if (db) {
        const hasFilter = status && status !== "all";
        rows = (await db.all(
          `SELECT * FROM listing_records ${hasFilter ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT ?`,
          hasFilter ? [status, limit] : [limit]
        )) as DbRow[];
      }

      const data = rows.map(rowToListingDto);
      res.json({
        success: true,
        data,
        count: data.length,
        // Extra summary for n8n canvas monitoring note — `data` stays an array per swagger/frontend.
        stats: memoryStats(),
        correlationId: req.correlationId,
      });
    } catch (err) {
      serverError(res, req, "LISTINGS_ERROR", err);
    }
  };
  router.get("/listings", listingsHandler);
  router.post("/listings", listingsHandler);

  return router;
}
