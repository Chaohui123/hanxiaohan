// ============================================================
// Market Analysis Routes — Ozon 7-module market intelligence
// POST /api/market/analysis — execute full analysis
// GET  /api/market/report/:id — query/download report
// ============================================================

import { Router } from "express";
import { logger } from "@onzo/logger";
import { getDb } from "../db/connection.js";
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

  // ---- GET /api/market/list-snapshot — paginated snapshot list ----
  router.get("/market/list-snapshot", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const page = parseInt(req.query.page as string || "1", 10);
      const limit = Math.min(parseInt(req.query.limit as string || "20", 10), 50);
      const offset = (page - 1) * limit;

      const rows = db ? await db.all<Record<string, string>>(
        "SELECT id, date, listed_count, created_at FROM market_snapshots ORDER BY date DESC LIMIT ? OFFSET ?",
        [String(limit), String(offset)]
      ) : [];
      const total = db ? (await db.all<{c:number}>("SELECT COUNT(*) as c FROM market_snapshots"))[0]?.c || 0 : 0;

      res.json({ success: true, data: rows, total, page, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DB_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // ---- GET /api/market/detail/:date — structured market data for frontend ----
  router.get("/market/detail/:date", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const date = req.params.date;
      const snapshot = db
        ? await db.all<{ data_json: string; listed_count: number }>(
            "SELECT data_json, listed_count FROM market_snapshots WHERE date = ? LIMIT 1", [date]
          )
        : [];

      const raw = snapshot[0] ? JSON.parse(snapshot[0].data_json || "{}") : {};

      res.json({
        success: true,
        data: {
          date,
          overview: raw.overview || { totalSales: 0, avgMargin: 0, blueOceanCount: 0, pendingAdjust: 0, avgCpc: 0 },
          categories: raw.categories || [],
          products: raw.products || [],
          keywords: raw.keywords || [],
          costs: raw.costs || [],
          competitors: raw.competitors || [],
          listedCount: snapshot[0]?.listed_count || 0,
          llmReport: raw.llmReport || "",
        },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DB_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // ---- GET /api/market/keyword/:date — keyword ranking ----
  router.get("/market/keyword/:date", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const snapshot = db
        ? await db.all<{ data_json: string }>("SELECT data_json FROM market_snapshots WHERE date = ? LIMIT 1", [req.params.date])
        : [];
      const raw = snapshot[0] ? JSON.parse(snapshot[0].data_json || "{}") : {};
      const keywords = raw.keywords || [];

      res.json({ success: true, data: keywords, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DB_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // ---- GET /api/market/cost/:date — cost breakdown ----
  router.get("/market/cost/:date", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const snapshot = db
        ? await db.all<{ data_json: string }>("SELECT data_json FROM market_snapshots WHERE date = ? LIMIT 1", [req.params.date])
        : [];
      const raw = snapshot[0] ? JSON.parse(snapshot[0].data_json || "{}") : {};
      const costs = raw.costs || [];

      res.json({ success: true, data: costs, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DB_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // ---- GET /api/market/competitor/:date — competitor pricing ----
  router.get("/market/competitor/:date", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const snapshot = db
        ? await db.all<{ data_json: string }>("SELECT data_json FROM market_snapshots WHERE date = ? LIMIT 1", [req.params.date])
        : [];
      const raw = snapshot[0] ? JSON.parse(snapshot[0].data_json || "{}") : {};
      const competitors = raw.competitors || [];

      res.json({ success: true, data: competitors, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DB_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
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
