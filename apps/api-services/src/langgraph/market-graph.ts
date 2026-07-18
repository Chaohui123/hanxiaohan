// ============================================================
// Market Analysis Graph — 7-module Ozon market intelligence
//
// Flow: Ops crawl → Promo crawl → LLM analysis → Export → END
// Fault isolation: any node failure doesn't break the pipeline
// ============================================================

import { StateGraph, END } from "@langchain/langgraph";
import { MarketAnalysisState } from "./market-state.js";
import { opsMarketCrawlNode, promoMarketCrawlNode, llmMarketAnalysisNode } from "./nodes/market-crawl.js";
import { logger } from "@onzo/logger";
import { randomUUID } from "node:crypto";

// ---- Export report node ----

async function exportReportNode(
  state: typeof MarketAnalysisState.State,
): Promise<Partial<typeof MarketAnalysisState.State>> {
  logger.info({ taskId: state.taskId }, "MarketGraph: generating export");

  try {
    const reportId = `rpt_${Date.now()}_${randomUUID().slice(0, 8)}`;

    // Build CSV report from all modules
    const rows: string[] = [];
    rows.push("模块,数据摘要,AI分析");
    rows.push(`大盘市场,${state.marketOverview?.categoryName || ""},${state.llmReport?.marketOverviewLLM || ""}`);
    rows.push(`行业类目,${state.categoryAnalysis?.categoryName || ""},${state.llmReport?.categoryAnalysisLLM || ""}`);
    rows.push(`单品分析,${state.productAnalysis?.title || ""},${state.llmReport?.productAnalysisLLM || ""}`);
    rows.push(`关键词,${state.keyword},${state.llmReport?.keywordAnalysisLLM || ""}`);
    rows.push(`成本拆解,总成本:${state.costBreakdown?.totalCostRub || 0}₽,${state.llmReport?.costBreakdownLLM || ""}`);
    rows.push(`同行比价,${state.competitorAnalysis?.competitors.length || 0}个竞品,${state.llmReport?.competitorAnalysisLLM || ""}`);
    rows.push(`综合评分,${state.llmReport?.overallScore || "N/A"}分,${state.llmReport?.recommendation || ""}`);

    // Store report in memory (persist via API later)
    _reportStore.set(reportId, {
      id: reportId,
      taskId: state.taskId,
      category: state.category,
      csv: rows.join("\n"),
      summary: state.llmReport?.summary || "",
      score: state.llmReport?.overallScore || 0,
      createdAt: new Date().toISOString(),
    });

    return { reportId, exportError: "" };
  } catch (err) {
    return { exportError: (err as Error).message };
  }
}

// ---- Alert dispatch node ----

async function alertNode(
  state: typeof MarketAnalysisState.State,
): Promise<Partial<typeof MarketAnalysisState.State>> {
  const hasFailures = (state.opsCrawlErrors?.length || 0) > 0 || (state.promoCrawlErrors?.length || 0) > 0;
  const alerts = state.alerts || [];

  if (hasFailures) {
    alerts.push({
      level: "warn",
      event: "MARKET_ANALYSIS_PARTIAL",
      message: `市场分析部分数据抓取失败 (Ops:${state.opsCrawlErrors?.length || 0}, Promo:${state.promoCrawlErrors?.length || 0})`,
    });
  } else {
    alerts.push({
      level: "info",
      event: "MARKET_ANALYSIS_COMPLETE",
      message: `7大模块市场分析完成 (报告ID: ${state.reportId})`,
    });
  }

  // Best-effort TG notify
  try {
    const { notifier } = await import("../services/notifier.js");
    for (const a of alerts) {
      await notifier.notify({
        level: a.level as "info" | "warn",
        event: a.event,
        message: a.message,
        correlationId: state.taskId,
        force: a.level === "warn",
      }).catch(() => {});
    }
  } catch { /* notifier unavailable */ }

  return { hasFailures, alerts };
}

// ---- Build graph ----

function buildMarketGraph() {
  return new StateGraph(MarketAnalysisState)
    .addNode("ops_crawl", opsMarketCrawlNode)
    .addNode("promo_crawl", promoMarketCrawlNode)
    .addNode("llm_analysis", llmMarketAnalysisNode)
    .addNode("export_report", exportReportNode)
    .addNode("alert", alertNode)

    .addEdge("__start__", "ops_crawl")
    .addEdge("ops_crawl", "promo_crawl")
    .addEdge("promo_crawl", "llm_analysis")
    .addEdge("llm_analysis", "export_report")
    .addEdge("export_report", "alert")
    .addEdge("alert", END)

    .compile();
}

let _marketGraph: ReturnType<typeof buildMarketGraph> | null = null;

export function getMarketGraph() {
  if (!_marketGraph) _marketGraph = buildMarketGraph();
  return _marketGraph;
}

// ---- Report store (in-memory, lost on restart) ----

interface StoredReport {
  id: string; taskId: string; category: string;
  csv: string; summary: string; score: number; createdAt: string;
}

export const _reportStore = new Map<string, StoredReport>();

// ---- Execute ----

export async function executeMarketAnalysis(input: {
  category?: string; productId?: string; keyword?: string;
}): Promise<typeof MarketAnalysisState.State> {
  const taskId = `market_${Date.now()}`;
  logger.info({ taskId, ...input }, "MarketGraph: starting analysis");

  const graph = getMarketGraph();
  return graph.invoke({
    category: input.category || "",
    productId: input.productId || "",
    keyword: input.keyword || "",
    taskId,
    marketOverview: null,
    categoryAnalysis: null,
    productAnalysis: null,
    costBreakdown: null,
    competitorAnalysis: null,
    opsCrawlErrors: [],
    keywordAnalysis: null,
    promoCrawlErrors: [],
    pricing: null,
    pricingError: "",
    llmReport: null,
    llmError: "",
    reportId: "",
    exportError: "",
    alerts: [],
    hasFailures: false,
  });
}
