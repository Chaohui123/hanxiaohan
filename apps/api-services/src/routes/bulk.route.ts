// ============================================================
// Bulk Import — Excel/CSV batch listing
// Accepts JSON array of products for mass Ozon draft creation
// ============================================================

import { Router } from "express";
import type { TaskQueue } from "../db/task-queue.js";

export function createBulkRouter(taskQueue: TaskQueue): Router {
  const router = Router();

  // POST /api/bulk/import — accepts JSON array, enqueues each
  router.post("/bulk/import", async (req, res) => {
    const { products } = req.body as {
      products: Array<{
        title: string;
        priceCny: number;
        specImages: string[];
        specifications?: Array<{ name: string; value: string }>;
        descriptionText?: string;
      }>;
    };

    if (!products || !Array.isArray(products) || products.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: "MISSING_PRODUCTS", message: "products array required", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }

    if (products.length > 100) {
      res.status(400).json({
        success: false,
        error: { code: "TOO_MANY", message: "Max 100 products per batch", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }

    const taskIds: string[] = [];
    for (const p of products) {
      const queued = await taskQueue.enqueue({
        type: "batch_listing",
        payload: p as Record<string, unknown>,
        correlationId: req.correlationId,
      });
      taskIds.push(queued.id);
    }

    res.status(202).json({
      success: true,
      data: { enqueued: taskIds.length, taskIds },
      message: "Bulk import queued. Poll GET /api/task/queue/stats for progress.",
      correlationId: req.correlationId,
    });
  });

  return router;
}
