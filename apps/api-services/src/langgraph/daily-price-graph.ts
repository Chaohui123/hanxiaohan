// ============================================================
// Daily Price Adjustment Graph (LangGraph)
// Ops: competitor prices, inventory | Promo: ad costs, sales
// LLM: dynamic pricing strategy → Ops: batch price update
// ============================================================

import { StateGraph, END, Annotation } from "@langchain/langgraph";
import { logger } from "@onzo/logger";
import { deepseekComplete } from "./client/deepseek-client.js";
import { getDb } from "../db/connection.js";

const State = Annotation.Root({
  date: Annotation<string>(),
  errors: Annotation<string[]>(),
  competitorData: Annotation<string>(),
  adPerformance: Annotation<string>(),
  pricePlan: Annotation<Array<{ offerId: string; oldPrice: number; newPrice: number; reason: string }>>(),
  adjustedCount: Annotation<number>(),
  report: Annotation<Array<{ id: string; oldPrice: number; newPrice: number }>>(),
});

// Node 1: Ops competitor crawl
async function opsCompetitorCrawl(s: typeof State.State): Promise<Partial<typeof State.State>> {
  logger.info("DailyPrice: Ops competitor crawl");
  try {
    const db = await getDb().catch(() => null);
    const rows = db ? await db.all<Record<string, unknown>>("SELECT COUNT(*) as c FROM inventory") as Array<{c:number}> : [];
    return { competitorData: `Products: ${rows[0]?.c||0}` };
  } catch (e) { return { errors: [((e as Error).message)] }; }
}

// Node 2: Promo ad performance
async function promoAdPerf(s: typeof State.State): Promise<Partial<typeof State.State>> {
  return { adPerformance: "暂无广告数据" };
}

// Node 3: LLM pricing strategy
async function llmPricing(s: typeof State.State): Promise<Partial<typeof State.State>> {
  logger.info("DailyPrice: LLM pricing");
  try {
    const raw = await deepseekComplete(
      "你是Ozon定价专家。根据竞品和广告数据，输出调价方案JSON数组: [{offerId,oldPrice,newPrice,reason}]",
      `竞品: ${s.competitorData}. 广告: ${s.adPerformance}`,
    );
    const match = raw.match(/\[[\s\S]*\]/);
    const plan = match ? JSON.parse(match[0]) : [];
    return { pricePlan: plan.slice(0, 20) };
  } catch (e) {
    return { errors: [((e as Error).message)], pricePlan: [] };
  }
}

// Node 4: Execute price updates
async function execPriceUpdate(s: typeof State.State): Promise<Partial<typeof State.State>> {
  let count = 0;
  const report: Array<{ id: string; oldPrice: number; newPrice: number }> = [];
  for (const p of s.pricePlan) {
    try {
      await fetch(`${process.env.API_BASE_URL || "http://localhost:3000"}/api/inventory/${p.offerId}/price`, {
        method: "PUT",
        headers: { "X-API-Key": process.env.API_KEY || "", "Content-Type": "application/json" },
        body: JSON.stringify({ price: p.newPrice }),
        signal: AbortSignal.timeout(15_000),
      });
      count++;
      report.push({ id: p.offerId, oldPrice: p.oldPrice, newPrice: p.newPrice });
    } catch { /* skip */ }
  }
  return { adjustedCount: count, report };
}

// Build
export function buildDailyPriceGraph() {
  return new StateGraph(State)
    .addNode("ops_crawl", opsCompetitorCrawl)
    .addNode("promo_perf", promoAdPerf)
    .addNode("llm_pricing", llmPricing)
    .addNode("exec_price", execPriceUpdate)
    .addEdge("__start__", "ops_crawl")
    .addEdge("ops_crawl", "promo_perf")
    .addEdge("promo_perf", "llm_pricing")
    .addEdge("llm_pricing", "exec_price")
    .addEdge("exec_price", END)
    .compile();
}

export async function executeDailyPriceAdjust(): Promise<typeof State.State> {
  const graph = buildDailyPriceGraph();
  return graph.invoke({
    date: new Date().toISOString().split("T")[0],
    errors: [],
    competitorData: "",
    adPerformance: "",
    pricePlan: [],
    adjustedCount: 0,
    report: [],
  });
}
