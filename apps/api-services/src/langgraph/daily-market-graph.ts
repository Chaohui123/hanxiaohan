// ============================================================
// Daily Market Poll + Auto-List Graph (LangGraph)
// Ops: market data, costs, listing | Promo: keywords, ads
// LLM: filter products, score, recommend listing
// ============================================================

import { StateGraph, END, Annotation } from "@langchain/langgraph";
import { logger } from "@onzo/logger";
import { deepseekComplete } from "./client/deepseek-client.js";
import { getDb } from "../db/connection.js";
import { randomUUID } from "node:crypto";

const State = Annotation.Root({
  date: Annotation<string>(),
  errors: Annotation<string[]>(),
  marketData: Annotation<string>(),
  adData: Annotation<string>(),
  recommendedProducts: Annotation<Array<{ title: string; url: string; price: number; score: number; reason: string }>>(),
  listedCount: Annotation<number>(),
  snapshotId: Annotation<string>(),
});

// Node 1: Ops market crawl (simplified — reuses existing dashboard/inventory APIs)
async function opsMarketCrawl(s: typeof State.State): Promise<Partial<typeof State.State>> {
  logger.info("DailyMarket: Ops crawl");
  try {
    const db = await getDb().catch(() => null);
    const rows = db ? await db.all<Record<string, unknown>>("SELECT COUNT(*) as c FROM inventory") as Array<{c:number}> : [];
    return { marketData: `Inventory: ${rows[0]?.c||0} items` };
  } catch (e) { return { errors: [((e as Error).message)] }; }
}

// Node 2: Promo ad crawl
async function promoAdCrawl(s: typeof State.State): Promise<Partial<typeof State.State>> {
  logger.info("DailyMarket: Promo crawl");
  return { adData: "ad_data_placeholder" };
}

// Node 3: LLM analyze + recommend
async function llmAnalyze(s: typeof State.State): Promise<Partial<typeof State.State>> {
  logger.info("DailyMarket: LLM analysis");
  try {
    const raw = await deepseekComplete(
      "你是Ozon选品专家。根据大盘数据，推荐3-5个适合上架的商品。返回JSON数组: [{title,url,price,score(0-100),reason}]",
      `大盘: ${s.marketData}. 广告: ${s.adData}. 类目: Электроника`,
    );
    const match = raw.match(/\[[\s\S]*\]/);
    const products = match ? JSON.parse(match[0]) : [];
    return { recommendedProducts: products.slice(0, 5) };
  } catch (e) {
    return { errors: [((e as Error).message)], recommendedProducts: [] };
  }
}

// Node 4: Auto-list recommended products
async function autoList(s: typeof State.State): Promise<Partial<typeof State.State>> {
  let count = 0;
  for (const p of s.recommendedProducts) {
    if (!p.url || p.score < 50) continue;
    try {
      await fetch(`${process.env.API_BASE_URL || "http://localhost:3000"}/api/process`, {
        method: "POST",
        headers: { "X-API-Key": process.env.API_KEY || "", "Content-Type": "application/json" },
        body: JSON.stringify({ url: p.url, storeId: "store_1" }),
        signal: AbortSignal.timeout(30_000),
      });
      count++;
    } catch { /* skip failed listing */ }
  }
  return { listedCount: count };
}

// Node 5: Save snapshot
async function saveSnapshot(s: typeof State.State): Promise<Partial<typeof State.State>> {
  try {
    const db = await getDb().catch(() => null);
    if (db) {
      const id = `snap_${s.date}_${randomUUID().slice(0, 8)}`;
      await db.run(
        "INSERT INTO market_snapshots (id, date, data_json, listed_count, created_at) VALUES (?,?,?,?,datetime('now'))",
        [id, s.date, JSON.stringify({ recommended: s.recommendedProducts }), s.listedCount],
      );
      return { snapshotId: id };
    }
    return {};
  } catch { return {}; }
}

// Build
export function buildDailyMarketGraph() {
  return new StateGraph(State)
    .addNode("ops_crawl", opsMarketCrawl)
    .addNode("promo_crawl", promoAdCrawl)
    .addNode("llm_analyze", llmAnalyze)
    .addNode("auto_list", autoList)
    .addNode("save_snapshot", saveSnapshot)
    .addEdge("__start__", "ops_crawl")
    .addEdge("ops_crawl", "promo_crawl")
    .addEdge("promo_crawl", "llm_analyze")
    .addEdge("llm_analyze", "auto_list")
    .addEdge("auto_list", "save_snapshot")
    .addEdge("save_snapshot", END)
    .compile();
}

export async function executeDailyMarketPoll(): Promise<typeof State.State> {
  const graph = buildDailyMarketGraph();
  return graph.invoke({
    date: new Date().toISOString().split("T")[0],
    errors: [],
    marketData: "",
    adData: "",
    recommendedProducts: [],
    listedCount: 0,
    snapshotId: "",
  });
}
