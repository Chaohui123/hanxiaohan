// ============================================================
// LangGraph Workflow Routes — Ozon procurement & RAG chat
// POST /api/order/execute  — execute full procurement workflow
// POST /api/rag/chat       — RAG Q&A via DeepSeek
// ============================================================

import { Router } from "express";
import { logger } from "@onzo/logger";
import { executeProcurementWorkflow, executeRagWorkflow } from "../langgraph/graph.js";

export function createLangGraphRouter(): Router {
  const router = Router();

  // ---- Procurement Workflow ----
  router.post("/order/execute", async (req, res) => {
    try {
      const { postingNumber, storeId } = (req.body || {}) as {
        postingNumber?: string; storeId?: string;
      };

      if (!postingNumber) {
        return res.status(400).json({
          success: false,
          error: { code: "MISSING", message: "postingNumber is required" },
          correlationId: req.correlationId,
        });
      }

      logger.info({ postingNumber }, "API: executing LangGraph procurement workflow");

      const result = await executeProcurementWorkflow({
        postingNumber,
        storeId: storeId || "store_1",
      });

      const response = {
        success: true,
        data: {
          postingNumber,
          purchaseId: result.purchaseId || null,
          profit: result.profit || null,
          errors: [
            result.orderSyncError,
            result.matchError,
            result.profitError,
            result.purchaseError,
          ].filter(Boolean),
          alerts: result.alerts || [],
        },
        correlationId: req.correlationId,
      };

      // Determine HTTP status based on outcome
      const hasErrors = result.orderSyncError || result.purchaseError;
      if (hasErrors) {
        res.status(422).json(response);
      } else if (result.profit && !result.profit.isProfitable) {
        res.status(200).json({ ...response, message: "Order processed — not profitable, purchase skipped" });
      } else {
        res.json(response);
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, "LangGraph procurement workflow error");
      res.status(500).json({
        success: false,
        error: { code: "WORKFLOW_ERROR", message: (err as Error).message },
        correlationId: req.correlationId,
      });
    }
  });

  // ---- RAG Chat ----
  router.post("/rag/chat", async (req, res) => {
    try {
      const { query, postingNumber } = (req.body || {}) as {
        query?: string; postingNumber?: string;
      };

      if (!query) {
        return res.status(400).json({
          success: false,
          error: { code: "MISSING", message: "query is required" },
          correlationId: req.correlationId,
        });
      }

      logger.info({ query: query.slice(0, 80) }, "API: executing LangGraph RAG chat");

      const result = await executeRagWorkflow({
        query,
        postingNumber: postingNumber || "",
        storeId: "store_1",
      });

      res.json({
        success: true,
        data: {
          query: result.ragQuery,
          answer: result.ragResult?.answer || "",
          sources: result.ragResult?.sources || [],
          tokensUsed: result.ragResult?.tokensUsed || 0,
          orderContext: result.ozonOrder ? {
            postingNumber: result.ozonOrder.postingNumber,
            status: result.ozonOrder.status,
            productCount: result.ozonOrder.products.length,
          } : null,
        },
        correlationId: req.correlationId,
      });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "LangGraph RAG chat error");
      res.status(500).json({
        success: false,
        error: { code: "RAG_ERROR", message: (err as Error).message },
        correlationId: req.correlationId,
      });
    }
  });

  return router;
}
