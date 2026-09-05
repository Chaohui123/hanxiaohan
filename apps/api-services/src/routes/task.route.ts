import { Router } from "express";
import { logger } from "@onzo/logger";
import { triggerMarketPoll, triggerPriceAdjust, taskLogs } from "../task/schedule-task.js";

export function createTaskTriggerRouter(): Router {
  const router = Router();

  router.post("/run-market", async (_req, res) => {
    try {
      const log = await triggerMarketPoll();
      res.json({ success: true, data: log, correlationId: _req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "TASK_ERROR", message: (err as Error).message }, correlationId: _req.correlationId });
    }
  });

  router.post("/run-price", async (_req, res) => {
    try {
      const log = await triggerPriceAdjust();
      res.json({ success: true, data: log, correlationId: _req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "TASK_ERROR", message: (err as Error).message }, correlationId: _req.correlationId });
    }
  });

  // 手动触发每日学习（B站知识 → DeepSeek 提炼 → RAG 知识库）
  router.post("/run-learning", async (_req, res) => {
    try {
      const { runDailyLearning } = await import("../jobs/daily-learning.js");
      const stats = await runDailyLearning();
      res.json({ success: true, data: stats, correlationId: _req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "TASK_ERROR", message: (err as Error).message }, correlationId: _req.correlationId });
    }
  });

  router.get("/logs", (_req, res) => {
    res.json({ success: true, data: taskLogs.slice(0, 20), correlationId: _req.correlationId });
  });

  return router;
}
