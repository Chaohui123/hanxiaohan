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

  // POST /api/task/deadletter/retry-batch — batch retry failed tasks
  router.post("/deadletter/retry-batch", async (req, res) => {
    const { taskIds } = req.body as { taskIds?: string[] };
    if (!taskIds || taskIds.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: "MISSING_IDS", message: "taskIds array required", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }

    const results: Array<{ taskId: string; requeued: boolean }> = [];
    for (const tid of taskIds) {
      const task = await taskQueue.retry(tid);
      results.push({ taskId: tid, requeued: !!task });
    }

    res.json({
      success: true,
      data: { results, retried: results.filter((r) => r.requeued).length, total: taskIds.length },
      correlationId: req.correlationId,
    });
  });

  return router;
}
