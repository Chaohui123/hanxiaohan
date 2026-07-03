// ============================================================
// Task routes — failed task retry, queue status, listing history
// ============================================================

import { Router } from "express";
import type { TaskQueue, TaskStatus as TaskQueueStatus } from "../db/task-queue.js";
import { getFailedTasks, getListingRecords } from "../db/models.js";

export function createTaskRouter(taskQueue: TaskQueue): Router {
  const router = Router();

  // Queue stats
  router.get("/queue/stats", (req, res) => {
    res.json({
      success: true,
      data: taskQueue.getStats(),
      correlationId: req.correlationId,
    });
  });

  // Queued tasks
  router.get("/queue", (req, res) => {
    const status = (req.query.status as string) ?? undefined;
    const tasks = taskQueue.listTasks(status as TaskQueueStatus, 50);
    res.json({
      success: true,
      data: tasks,
      correlationId: req.correlationId,
    });
  });

  // Failed tasks (from DB)
  router.get("/failed", async (req, res) => {
    try {
      const tasks = await getFailedTasks("store_1");
      res.json({
        success: true,
        data: tasks,
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "DB_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId,
      });
    }
  });

  // Retry failed task (re-queue)
  router.post("/retry/:taskId", async (req, res) => {
    const task = await taskQueue.retry(req.params.taskId);
    if (!task) {
      res.status(404).json({
        success: false,
        error: { code: "TASK_NOT_FOUND", message: "Task not found or max retries exceeded", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }

    res.json({
      success: true,
      data: task,
      message: "Task re-queued for retry",
      correlationId: req.correlationId,
    });
  });

  // Listing history
  router.get("/listings", async (req, res) => {
    try {
      const records = await getListingRecords(50);
      res.json({
        success: true,
        data: records,
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "DB_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId,
      });
    }
  });

  // POST /api/task/deadletter/retry-batch — batch retry with optional filtering
  router.post("/deadletter/retry-batch", async (req, res) => {
    const { taskIds, filterType } = req.body as { taskIds?: string[]; filterType?: string };

    // If filterType specified, get tasks from DB filtered by error type
    let idsToRetry = taskIds;
    if (filterType && !taskIds) {
      const db = await import("../db/models.js");
      const failed = await db.getFailedTasks("store_1");
      if (filterType === "api_error") {
        idsToRetry = failed
          .filter((t: { errorMessage: string; status: string }) =>
            t.status === "pending_retry" &&
            (t.errorMessage.includes("fetch failed") || t.errorMessage.includes("429") || t.errorMessage.includes("5xx") || t.errorMessage.includes("Ozon API error"))
          )
          .map((t: { id: string }) => t.id);
      } else if (filterType === "validation") {
        idsToRetry = failed
          .filter((t: { errorMessage: string; status: string }) =>
            t.status === "pending_retry" && t.errorMessage.includes("Validation")
          )
          .map((t: { id: string }) => t.id);
      } else if (filterType === "all_retryable") {
        idsToRetry = failed
          .filter((t: { errorMessage: string; status: string }) =>
            t.status === "pending_retry" &&
            !t.errorMessage.includes("insufficient stock") &&
            !t.errorMessage.includes("permanently")
          )
          .map((t: { id: string }) => t.id);
      }
    }

    if (!idsToRetry || idsToRetry.length === 0) {
      res.json({
        success: true,
        data: { results: [], retried: 0, total: 0, message: "No matching tasks to retry" },
        correlationId: req.correlationId,
      });
      return;
    }

    const results: Array<{ taskId: string; requeued: boolean }> = [];
    for (const tid of idsToRetry) {
      const task = await taskQueue.retry(tid);
      results.push({ taskId: tid, requeued: !!task });
    }

    res.json({
      success: true,
      data: { results, retried: results.filter((r) => r.requeued).length, total: idsToRetry.length },
      correlationId: req.correlationId,
    });
  });

  return router;
}
