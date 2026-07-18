// ============================================================
// Auto-Select Graph v2 — Dual-Agent with tie-breaking
// Configurable scoring weights, secondary sort, manual publish
// ============================================================

import { StateGraph, END } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { logger } from "@onzo/logger";
import { deepseekChatCompletion } from "./client/deepseek-client.js";
import { getDb } from "../db/connection.js";

// ---- Configurable scoring weights (from .env) ----
const W_MARGIN = parseInt(process.env.SCORE_WEIGHT_MARGIN || "40", 10);
const W_SALES = parseInt(process.env.SCORE_WEIGHT_SALE || "30", 10);
const W_COMPETE = parseInt(process.env.SCORE_WEIGHT_COMPETE || "20", 10);
const W_RETURN = parseInt(process.env.SCORE_WEIGHT_RETURN || "10", 10);
const W_TOTAL = W_MARGIN + W_SALES + W_COMPETE + W_RETURN;

// ---- State ----

export const AutoSelectState = Annotation.Root({
  keyword: Annotation<string>(),
  storeId: Annotation<string>(),

  candidates: Annotation<Array<{ url: string; title: string; price: number; reason: string }>>(),
  opsSearchError: Annotation<string>(),

  scored: Annotation<Array<{
    url: string; title: string; price: number; margin: number;
    opsScore: number; promoScore: number; finalScore: number;
    verdict: string; detail: { marginScore: number; salesScore: number; competeScore: number; returnScore: number };
  }>>(),
  promoScoreError: Annotation<string>(),

  // New: tie-breaking fields
  topScore: Annotation<number>(),
  topScoreProducts: Annotation<Array<{ url: string; title: string; price: number; margin: number; finalScore: number }>>(),
  validateFailType: Annotation<string>(),  // "none" | "noCandidates" | "multipleTopScore" | "lowScore"
  secondarySort: Annotation<Array<{ url: string; title: string; price: number; margin: number; finalScore: number }>>(),

  validationPassed: Annotation<boolean>(),
  validationIssues: Annotation<string[]>(),

  // Manual publish
  manualPublishId: Annotation<string>(),
  listingTaskId: Annotation<string>(),
  listingError: Annotation<string>(),

  promoPlanId: Annotation<string>(),
  promoError: Annotation<string>(),

  report: Annotation<string>(),
});

// ---- Node 1: Search 1688 ----
async function opsSearchNode(s: typeof AutoSelectState.State): Promise<Partial<typeof AutoSelectState.State>> {
  logger.info({ keyword: s.keyword }, "AutoSelect: searching 1688");
  try {
    const resp = await deepseekChatCompletion([
      { role: "system", content: "返回JSON: [{\"url\":\"https://detail.1688.com/offer/ID.html\",\"title\":\"商品名\",\"price\":价格元,\"reason\":\"推荐理由\"}]" },
      { role: "user", content: s.keyword },
    ], { temperature: 0.2, maxTokens: 1000 });
    const raw = resp.choices[0]?.message?.content || "[]";
    const m = raw.match(/\[[\s\S]*\]/);
    return { candidates: (m ? JSON.parse(m[0]) : []).slice(0, 5), opsSearchError: "" };
  } catch (e) { return { opsSearchError: (e as Error).message, candidates: [] }; }
}

// ---- Node 2: Configurable scoring with tie-breaking ----
async function promoScoreNode(s: typeof AutoSelectState.State): Promise<Partial<typeof AutoSelectState.State>> {
  const cands = s.candidates;
  if (cands.length === 0) return { promoScoreError: "No candidates", scored: [], topScore: 0, topScoreProducts: [] };

  const scored = cands.map(c => {
    // Multi-dimension scoring with configurable weights (based on real metrics, no random)
    const marginScore = Math.min(1, Math.max(0, (200 - c.price) / 150));
    const salesScore = 0.5;    // will be replaced by real sales data when available
    const competeScore = c.price < 100 ? 0.8 : c.price < 200 ? 0.6 : 0.3;
    const returnScore = 0.5;   // will be replaced by real return rate data when available

    const finalScore = Math.round(
      (marginScore * W_MARGIN + salesScore * W_SALES + competeScore * W_COMPETE + returnScore * W_RETURN) / W_TOTAL * 100
    );

    return {
      url: c.url, title: c.title, price: c.price,
      margin: Math.round((1 - c.price / 200) * 100),
      opsScore: Math.round((marginScore * 0.5 + competeScore * 0.5) * 100),
      promoScore: Math.round((salesScore * 0.6 + returnScore * 0.4) * 100),
      finalScore,
      verdict: finalScore >= 60 ? "recommend" : finalScore >= 40 ? "review" : "skip",
      detail: {
        marginScore: Math.round(marginScore * 100),
        salesScore: Math.round(salesScore * 100),
        competeScore: Math.round(competeScore * 100),
        returnScore: Math.round(returnScore * 100),
      },
    };
  });
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Find top score and tie products
  const topScore = scored[0]?.finalScore || 0;
  const topScoreProducts = scored
    .filter(p => p.finalScore === topScore)
    .map(p => ({ url: p.url, title: p.title, price: p.price, margin: p.margin, finalScore: p.finalScore }));

  // Secondary sort: margin desc → price asc → (margin already in display)
  const secondarySort = [...topScoreProducts].sort((a, b) => {
    if (b.margin !== a.margin) return b.margin - a.margin;
    return a.price - b.price;
  });

  return { scored, topScore, topScoreProducts, secondarySort, promoScoreError: "" };
}

// ---- Node 3: Improved Cross-Validation ----
async function crossValidateNode(s: typeof AutoSelectState.State): Promise<Partial<typeof AutoSelectState.State>> {
  const issues: string[] = [];
  let failType = "none";

  if (s.candidates.length === 0) {
    failType = "noCandidates";
    issues.push("未找到候选商品");
    return { validationPassed: false, validationIssues: issues, validateFailType: failType };
  }

  const top = s.scored[0];
  if (!top) { failType = "noCandidates"; issues.push("无有效候选"); return { validationPassed: false, validationIssues: issues, validateFailType: failType }; }

  // Check for tie
  if ((s.topScoreProducts || []).length >= 2) {
    failType = "multipleTopScore";
    issues.push("存在多款同分高分商品，系统无法自动选定唯一上架单品，请手动选择");
    return { validationPassed: false, validationIssues: issues, validateFailType: failType };
  }

  // URL check
  if (!top.url.match(/https:\/\/detail\.1688\.com\/offer\/\d+\.html/)) {
    issues.push("URL格式异常");
  }
  // Price check
  if (top.price <= 0 || top.price > 10000) issues.push("价格异常");
  // Score check
  if (top.finalScore < 50) { failType = "lowScore"; issues.push("综合评分过低"); }

  const passed = issues.length === 0;
  if (!passed && !failType) failType = "lowScore";

  // Save diagnosis to DB
  try {
    const db = await getDb().catch(() => null);
    if (db) {
      db.exec("CREATE TABLE IF NOT EXISTS auto_select_diagnosis (id TEXT PRIMARY KEY, task_id TEXT, keyword TEXT, top_score INTEGER, top_products_json TEXT, fail_type TEXT, issues_json TEXT, created_at TEXT DEFAULT (datetime('now')))");
      await db.run("INSERT INTO auto_select_diagnosis (id, task_id, keyword, top_score, top_products_json, fail_type, issues_json, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))",
        [`diag_${Date.now()}`, s.manualPublishId || s.keyword, s.keyword, s.topScore, JSON.stringify(s.secondarySort || []), failType, JSON.stringify(issues)]
      );
    }
  } catch { /* DB optional */ }

  return { validationPassed: passed, validationIssues: issues, validateFailType: failType };
}

// ---- Node 4: Auto List ----
async function autoListNode(s: typeof AutoSelectState.State): Promise<Partial<typeof AutoSelectState.State>> {
  const top = s.scored[0];
  if (!top || !s.validationPassed) return {};
  try {
    const r = await fetch(`${process.env.API_BASE_URL || "http://localhost:3000"}/api/process`, {
      method: "POST", headers: { "X-API-Key": process.env.API_KEY || "", "Content-Type": "application/json" },
      body: JSON.stringify({ url: top.url, storeId: s.storeId || "store_1" }), signal: AbortSignal.timeout(30_000),
    });
    const d = await r.json() as { data?: { taskId?: string } };
    return { listingTaskId: d.data?.taskId || "submitted" };
  } catch (e) { return { listingError: (e as Error).message }; }
}

// ---- Node 5: Manual Publish (bypass auto-check) ----
async function manualPublishNode(s: typeof AutoSelectState.State): Promise<Partial<typeof AutoSelectState.State>> {
  const url = s.manualPublishId;
  if (!url) return { listingError: "No URL specified" };
  logger.info({ url }, "AutoSelect: manual publish");
  try {
    await fetch(`${process.env.API_BASE_URL || "http://localhost:3000"}/api/process`, {
      method: "POST", headers: { "X-API-Key": process.env.API_KEY || "", "Content-Type": "application/json" },
      body: JSON.stringify({ url, storeId: s.storeId || "store_1" }), signal: AbortSignal.timeout(30_000),
    });
    return { listingTaskId: "manual_ok" };
  } catch (e) { return { listingError: (e as Error).message }; }
}

// ---- Node 6: Promo Ad ----
async function autoPromoNode(s: typeof AutoSelectState.State): Promise<Partial<typeof AutoSelectState.State>> {
  if (!s.listingTaskId) return {};
  try {
    await fetch(`${process.env.API_BASE_URL || "http://localhost:3000"}/api/promo/decision`, {
      method: "POST", headers: { "X-API-Key": process.env.API_KEY || "", "Content-Type": "application/json" },
      body: JSON.stringify({ id: `auto_${Date.now()}`, actions: [{ offerId: s.listingTaskId, type: "launch_ad" }] }),
      signal: AbortSignal.timeout(15_000),
    });
    return { promoPlanId: "created" };
  } catch (e) { return { promoError: (e as Error).message }; }
}

// ---- Node 7: Report ----
async function reportNode(s: typeof AutoSelectState.State): Promise<Partial<typeof AutoSelectState.State>> {
  const lines: string[] = [];
  lines.push(`## 自动选品 — "${s.keyword}"`);
  lines.push("");

  if (s.validateFailType === "multipleTopScore") {
    lines.push(`⚠️ 校验未通过：存在 ${s.topScoreProducts?.length || 0} 款同分高分商品 (${s.topScore}分)，系统无法自动选定，请手动选择：`);
    for (const p of (s.secondarySort || []).slice(0, 5)) {
      lines.push(`  ${p.finalScore}分 | ${p.title.slice(0, 40)} | ¥${p.price} | 毛利${p.margin}%`);
    }
  } else if (s.validateFailType === "noCandidates") {
    lines.push("❌ 未找到候选商品");
  } else if (s.validationPassed) {
    lines.push(`✅ 已自动上架: ${s.scored[0]?.title}`);
  } else {
    lines.push("⚠️ 验证未通过");
  }

  return { report: lines.join("\n") };
}

// ---- Conditions ----
function shouldAutoList(s: typeof AutoSelectState.State): "auto_list" | "gen_report" {
  return s.validationPassed && s.scored.length > 0 ? "auto_list" : "gen_report";
}

// ---- Build ----
export function buildAutoSelectGraph() {
  return new StateGraph(AutoSelectState)
    .addNode("ops_search", opsSearchNode)
    .addNode("promo_score", promoScoreNode)
    .addNode("cross_validate", crossValidateNode)
    .addNode("auto_list", autoListNode)
    .addNode("auto_promo", autoPromoNode)
    .addNode("gen_report", reportNode)

    .addEdge("__start__", "ops_search")
    .addEdge("ops_search", "promo_score")
    .addEdge("promo_score", "cross_validate")

    .addConditionalEdges("cross_validate", shouldAutoList, {
      auto_list: "auto_list", gen_report: "gen_report",
    })
    .addEdge("auto_list", "auto_promo")
    .addEdge("auto_promo", "gen_report")
    .addEdge("gen_report", END)
    .compile();
}

let _g: ReturnType<typeof buildAutoSelectGraph> | null = null;
export function getAutoSelectGraph() { if (!_g) _g = buildAutoSelectGraph(); return _g; }

export async function executeAutoSelect(keyword: string): Promise<typeof AutoSelectState.State> {
  return getAutoSelectGraph().invoke({
    keyword, storeId: "store_1",
    candidates: [], opsSearchError: "",
    scored: [], promoScoreError: "",
    topScore: 0, topScoreProducts: [], validateFailType: "none", secondarySort: [],
    validationPassed: false, validationIssues: [],
    manualPublishId: "", listingTaskId: "", listingError: "",
    promoPlanId: "", promoError: "", report: "",
  });
}

// ---- Manual publish entry (bypass auto-select, used by frontend picker) ----
export async function manualPublish(url: string, storeId: string = "store_1"): Promise<string> {
  try {
    const r = await fetch(`${process.env.API_BASE_URL || "http://localhost:3000"}/api/process`, {
      method: "POST", headers: { "X-API-Key": process.env.API_KEY || "", "Content-Type": "application/json" },
      body: JSON.stringify({ url, storeId }), signal: AbortSignal.timeout(30_000),
    });
    const d = await r.json() as { data?: { taskId?: string } };
    return d.data?.taskId || "ok";
  } catch (e) { throw e; }
}
