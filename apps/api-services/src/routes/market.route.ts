// ============================================================
// Market Analysis Routes — Ozon 7-module market intelligence
// POST /api/market/analysis — execute full analysis
// GET  /api/market/report/:id — query/download report
// ============================================================

import { Router } from "express";
import { logger } from "@onzo/logger";
import { executeMarketAnalysis, _reportStore } from "../langgraph/market-graph.js";

export function createMarketRouter(): Router {
  const router = Router();

  // ---- POST /api/market/analysis ----
  router.post("/market/analysis", async (req, res) => {
    try {
      const { category, productId, keyword } = (req.body || {}) as {
        category?: string; productId?: string; keyword?: string;
      };

      if (!category && !productId && !keyword) {
        return res.status(400).json({
          success: false,
          error: { code: "MISSING", message: "请提供 category, productId 或 keyword 至少一项" },
          correlationId: req.correlationId,
        });
      }

      logger.info({ category, productId, keyword }, "Market analysis requested");

      const result = await executeMarketAnalysis({ category, productId, keyword });

      res.json({
        success: true,
        data: {
          reportId: result.reportId,
          taskId: result.taskId,
          summary: result.llmReport?.summary || "",
          overallScore: result.llmReport?.overallScore || 0,
          recommendation: result.llmReport?.recommendation || "",
          hasFailures: result.hasFailures,
          modules: {
            marketOverview: !!result.marketOverview,
            categoryAnalysis: !!result.categoryAnalysis,
            productAnalysis: !!result.productAnalysis,
            keywordAnalysis: !!result.keywordAnalysis,
            costBreakdown: !!result.costBreakdown,
            competitorAnalysis: !!result.competitorAnalysis,
            llmReport: !!result.llmReport,
          },
        },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "MARKET_ANALYSIS_ERROR", message: (err as Error).message },
        correlationId: req.correlationId,
      });
    }
  });

  // ---- GET /api/market/report/:id ----
  router.get("/market/report/:id", (req, res) => {
    const report = _reportStore.get(req.params.id);
    if (!report) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "报告不存在或已过期" },
        correlationId: req.correlationId,
      });
    }

    const format = (req.query.format as string) || "json";
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=market-report-${report.id}.csv`);
      res.send("﻿" + report.csv);
    } else {
      res.json({ success: true, data: report, correlationId: req.correlationId });
    }
  });

  // ---- GET /api/market/reports — list recent reports ----
  router.get("/market/reports", (_req, res) => {
    const reports = Array.from(_reportStore.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map(r => ({ id: r.id, category: r.category, summary: r.summary, score: r.score, createdAt: r.createdAt }));

    res.json({ success: true, data: reports, correlationId: _req.correlationId });
  });

  return router;
}
