// ============================================================
// Full Pipeline Routes — Ops-Agent ↔ Promo-Agent orchestration
// POST /api/product/launch — trigger full closed-loop workflow
// GET  /api/workflow/status — query execution status
// ============================================================

import { Router } from "express";
import { logger } from "@onzo/logger";
import { executeFullPipeline } from "../langgraph/pipeline-graph.js";
import { deepseekHealthCheck } from "../langgraph/client/deepseek-client.js";

export function createPipelineRouter(): Router {
  const router = Router();

  // In-memory status store (survives single process, lost on restart)
  const workflowStatuses = new Map<string, {
    taskId: string;
    status: "running" | "completed" | "failed";
    startedAt: string;
    nodes: Array<{ agent: string; node: string; success: boolean; error?: string; durationMs: number }>;
    result?: Record<string, unknown>;
  }>();

  // ---- POST /api/product/launch ----
  router.post("/product/launch", async (req, res) => {
    try {
      const { sourceUrl, storeId } = (req.body || {}) as { sourceUrl?: string; storeId?: string };
      if (!sourceUrl) {
        return res.status(400).json({
          success: false,
          error: { code: "MISSING", message: "sourceUrl is required" },
          correlationId: req.correlationId,
        });
      }

      const taskId = `launch_${Date.now()}`;
      workflowStatuses.set(taskId, { taskId, status: "running", startedAt: new Date().toISOString(), nodes: [] });

      // Fire-and-forget — return taskId immediately
      executeFullPipeline({ sourceUrl, storeId: storeId || "store_1" })
        .then((result) => {
          workflowStatuses.set(taskId, {
            taskId,
            status: "completed",
            startedAt: workflowStatuses.get(taskId)?.startedAt || "",
            nodes: result.agentLog || [],
            result: {
              listingId: result.listing?.productId,
              promoPlanId: result.promo?.planId,
              orders: result.orders?.totalOrders,
              profitRub: result.fullProfit?.netProfitRub,
            },
          });
        })
        .catch((err) => {
          workflowStatuses.set(taskId, {
            taskId,
            status: "failed",
            startedAt: workflowStatuses.get(taskId)?.startedAt || "",
            nodes: [{ agent: "system", node: "pipeline", success: false, error: (err as Error).message, durationMs: 0 }],
          });
        });

      res.json({
        success: true,
        data: { taskId, status: "running" },
        message: "全流程已启动，通过 GET /api/workflow/status?taskId=... 查询进度",
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "PIPELINE_ERROR", message: (err as Error).message },
        correlationId: req.correlationId,
      });
    }
  });

  // ---- GET /api/workflow/status ----
  router.get("/workflow/status", (req, res) => {
    const taskId = req.query.taskId as string;
    if (!taskId) {
      // List all recent statuses
      const all = Array.from(workflowStatuses.values()).slice(-10);
      return res.json({ success: true, data: all, correlationId: req.correlationId });
    }

    const status = workflowStatuses.get(taskId);
    if (!status) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: `Task ${taskId} not found` },
        correlationId: req.correlationId,
      });
    }
    res.json({ success: true, data: status, correlationId: req.correlationId });
  });

  // ---- GET /api/health (extended) ----
  router.get("/health/extended", async (_req, res) => {
    const checks: Record<string, string> = {};

    // DeepSeek
    try {
      checks.deepseek = (await deepseekHealthCheck()) ? "ok" : "down";
    } catch {
      checks.deepseek = "down";
    }

    // Ozon API
    try {
      const ozonResp = await fetch(`${process.env.OZON_API_BASE || "https://api-seller.ozon.ru"}/v1/product/list`, {
        headers: { "Client-Id": process.env.OZON_CLIENT_IDS || "", "Api-Key": (process.env.OZON_API_KEYS || "").split(",")[0] || "" },
        signal: AbortSignal.timeout(5000),
      });
      checks.ozon = ozonResp.ok ? "ok" : "down";
    } catch {
      checks.ozon = "down";
    }

    res.json({
      success: true,
      data: {
        status: Object.values(checks).every((v) => v === "ok") ? "healthy" : "degraded",
        checks,
        timestamp: new Date().toISOString(),
      },
      correlationId: _req.correlationId,
    });
  });

  return router;
}
