import { Router, type Request } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import type { TaskQueue, TaskStatus as TaskQueueStatus } from "../db/task-queue.js";
import { getFailedTasks, getListingRecords, updateFailedTaskStatus } from "../db/models.js";
import { validate, CreateTaskSchema } from "../middleware/validate.js";

export function createTaskRouter(taskQueue: TaskQueue): Router {
  const router = Router();

  router.get("/queue/stats", (req, res) => {
    res.json({
      success: true,
      data: taskQueue.getStats(),
      correlationId: req.correlationId,
    });
  });

  router.get("/queue", (req, res) => {
    const status = (req.query.status as string) ?? undefined;
    const tasks = taskQueue.listTasks(status as TaskQueueStatus, 50);
    res.json({
      success: true,
      data: tasks,
      correlationId: req.correlationId,
    });
  });

  router.get("/failed", async (req, res) => {
    try {
      const storeId = (req.query.storeId as string | undefined) ?? "store_1";
      const tasks = await getFailedTasks(storeId);
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

    await updateFailedTaskStatus(req.params.taskId, {
      status: task.retryCount >= task.maxRetries ? "failed" : "retrying",
      retryCount: task.retryCount,
      errorMessage: null,
    }).catch(() => {});

    res.json({
      success: true,
      data: task,
      message: "Task re-queued for retry",
      correlationId: req.correlationId,
    });
  });

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

  router.post("/deadletter/retry-batch", async (req, res) => {
    const { taskIds, filterType, storeId } = req.body as { taskIds?: string[]; filterType?: string; storeId?: string };
    const targetStoreId = storeId ?? "store_1";

    let idsToRetry = taskIds;
    if (filterType && !taskIds) {
      const db = await import("../db/models.js");
      const failed = await db.getFailedTasks(targetStoreId);
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
      if (task) {
        await updateFailedTaskStatus(tid, {
          status: task.retryCount >= task.maxRetries ? "failed" : "retrying",
          retryCount: task.retryCount,
          errorMessage: null,
          storeId: targetStoreId,
        }).catch(() => {});
      }
      results.push({ taskId: tid, requeued: !!task });
    }

    res.json({
      success: true,
      data: { results, retried: results.filter((r) => r.requeued).length, total: idsToRetry.length },
      correlationId: req.correlationId,
    });
  });

  router.post("/create", validate(CreateTaskSchema), async (req, res) => {
    const body = (req as Request & { validatedBody: z.infer<typeof CreateTaskSchema> }).validatedBody;
    
    const task = await taskQueue.enqueue({
      type: body.type,
      payload: body.payload ?? {},
      correlationId: req.correlationId ?? crypto.randomUUID(),
      storeId: body.storeId,
      priority: body.priority,
      maxRetries: body.maxRetries,
    });

    res.json({
      success: true,
      data: task,
      message: "Task created successfully",
      correlationId: req.correlationId,
    });
  });

  return router;
}