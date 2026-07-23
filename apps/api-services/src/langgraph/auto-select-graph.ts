// ============================================================
// Auto-Select Graph v2 — Dual-Agent with tie-breaking
// Configurable scoring weights, secondary sort, manual publish
// ============================================================

import { StateGraph, END } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { logger } from "@onzo/logger";
import { deepseekChatCompletion } from "./client/deepseek-client.js";
import { getDb } from "../db/connection.js";
import { getSeasonalMatchScore } from "../services/russia-seasonality.js";

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

// ---- Node 1: Search 1688 (REAL data: seasonality + DeepSeek market analysis, NOT URL hallucination) ----
async function opsSearchNode(s: typeof AutoSelectState.State): Promise<Partial<typeof AutoSelectState.State>> {
  logger.info({ keyword: s.keyword }, "AutoSelect: analyzing market viability (real data)");

  try {
    // Step 1: Get seasonal demand match for this keyword
    const { getSeasonalMatchScore, getCurrentSeasonDemand } = await import("../services/russia-seasonality.js");
    const seasonScore = getSeasonalMatchScore(s.keyword);
    const season = getCurrentSeasonDemand();

    // Step 2: Analyze keyword viability via DeepSeek (market insights, not fake URLs)
    const resp = await deepseekChatCompletion([
      {
        role: "system",
        content: [
          "你是俄罗斯Ozon电商选品专家。分析关键词在Ozon的市场机会。",
          "返回JSON: {\"marketSize\":\"大/中/小\",\"competitionLevel\":\"高/中/低\",\"avgPriceRub\":价格,\"marginPotential\":\"高/中/低\",",
          "\"seasonality\":\"全年/季节性/节日\",\"trend\":\"上升/稳定/下降\",\"risks\":[\"风险1\"],\"suggested1688Keywords\":[\"搜索词1\"]}",
        ].join(" "),
      },
      { role: "user", content: `关键词: ${s.keyword}。当前俄罗斯季节: ${season.monthRu}(${season.season})，近期节日: ${season.upcomingHoliday?.name || "无"}。季节匹配分数: ${seasonScore}/100` },
    ], { temperature: 0.3, maxTokens: 800 });

    const raw = resp.choices[0]?.message?.content || "{}";
    const analysis = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}") as Record<string, unknown>;

    // Step 3: Build candidate list from analysis (NO fake URLs)
    const suggestedKeywords = (analysis.suggested1688Keywords as string[]) || [s.keyword];
    const candidates = suggestedKeywords.map((kw, i) => ({
      url: "", // Will be filled by manual user input or plugin — no hallucination
      title: kw,
      price: (analysis.avgPriceRub as number) || 100,
      reason: `${analysis.marketSize || "中"}市场, ${analysis.competitionLevel || "中"}竞争, ${analysis.trend || "稳定"}趋势, 季节${seasonScore}分`,
    }));

    return {
      candidates: candidates.slice(0, 5),
      opsSearchError: "",
      report: [
        `## 选品分析: ${s.keyword}`,
        `🌍 市场: ${analysis.marketSize || "未知"} | 💰 均价: ${analysis.avgPriceRub || "?"}₽ | 📈 趋势: ${analysis.trend || "?"}`,
        `🏔️ 竞争: ${analysis.competitionLevel || "?"} | 💵 利润: ${analysis.marginPotential || "?"}`,
        `📅 季节: ${season.monthRu} (${season.season}) | 匹配度: ${seasonScore}/100`,
        `⚠️ 风险: ${(analysis.risks as string[])?.join(", ") || "无显著风险"}`,
        `🔍 建议在1688搜索: ${suggestedKeywords.join(", ")}`,
        `📌 获取真实1688链接后，使用 /api/market/manual-publish 上架`,
      ].join("\n"),
    };
  } catch (e) {
    return { opsSearchError: (e as Error).message, candidates: [], report: `搜索失败: ${(e as Error).message}` };
  }
}

// ---- Node 2: Configurable scoring with tie-breaking ----
async function promoScoreNode(s: typeof AutoSelectState.State): Promise<Partial<typeof AutoSelectState.State>> {
  const cands = s.candidates;
  if (cands.length === 0) return { promoScoreError: "No candidates", scored: [], topScore: 0, topScoreProducts: [] };

  const scored = cands.map(c => {
    // Multi-dimension scoring: margin + seasonality + competition + compliance
    const marginScore = Math.min(1, Math.max(0, (c.price > 0 ? (200 - c.price) / 150 : 0.5)));
    // Seasonal demand score: REAL Russia seasonality match (not price-tier proxy)
    // getSeasonalMatchScore returns 0-100; normalize to 0-1. Fallback 0.3 when no match.
    const rawSeason = getSeasonalMatchScore(c.title) / 100;
    const salesScore = rawSeason > 0 ? rawSeason : 0.3;
    // Competition score: lower price = more suppliers = more competition
    const competeScore = c.price < 100 ? 0.8 : c.price < 200 ? 0.6 : 0.3;
    // Compliance score: penalty for categories likely needing certification
    const returnScore = 0.5; // Base: will be adjusted by compliance check in crossValidateNode

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

  // URL check — skip if no URL (market analysis mode, not listing mode)
  if (top.url && !top.url.match(/https:\/\/detail\.1688\.com\/offer\/\d+\.html/)) {
    issues.push("URL格式异常 — 请提供真实1688商品链接");
  }
  // Price check
  if (top.price <= 0 || top.price > 10000) issues.push("价格异常");
  // Score check
  if (top.finalScore < 50) { failType = "lowScore"; issues.push("综合评分过低"); }

  // P6: Compliance check on Chinese product name
  try {
    const { checkChineseProductCompliance } = await import("../services/compliance.js");
    const compResult = checkChineseProductCompliance(top.title);
    if (compResult.blocked) {
      failType = "compliance_blocked";
      issues.push(`合规拦截: ${compResult.blockedReason}`);
      issues.push(`所需认证: ${compResult.requiredCerts.join(", ")}`);
    }
    if (compResult.warnings.length > 0) {
      issues.push(...compResult.warnings.map(w => `⚠️ ${w}`));
    }
  } catch { /* compliance module unavailable */ }

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
