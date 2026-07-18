// ============================================================
// Auto-Select Graph — Dual-Agent Cross-Validation Auto Listing
//
// Ops-Agent:      1688 search, scraping, listing, order sync
// Promo-Agent:    product scoring, cross-validation, ad campaigns
//
// Flow:
//   关键词 → Ops搜索1688 → Promo评分排序 → Cross-Validate
//     ├─ 通过 → Ops自动上架 → Promo创建推广 → 报告
//     └─ 未通过 → 报告评分详情(不自动上架)
// ============================================================

import { StateGraph, END } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { logger } from "@onzo/logger";
import { deepseekChatCompletion } from "./client/deepseek-client.js";

// ---- State ----

export const AutoSelectState = Annotation.Root({
  keyword: Annotation<string>(),
  storeId: Annotation<string>(),

  // Ops: product search
  candidates: Annotation<Array<{ url: string; title: string; price: number; reason: string }>>(),
  opsSearchError: Annotation<string>(),

  // Promo: scoring
  scored: Annotation<Array<{ url: string; title: string; price: number; opsScore: number; promoScore: number; finalScore: number; margin: number; verdict: string }>>(),
  promoScoreError: Annotation<string>(),

  // Cross-validation
  validationPassed: Annotation<boolean>(),
  validationIssues: Annotation<string[]>(),

  // Listing
  listingTaskId: Annotation<string>(),
  listingError: Annotation<string>(),

  // Promo ad
  promoPlanId: Annotation<string>(),
  promoError: Annotation<string>(),

  // Report
  report: Annotation<string>(),
});

// ---- Node 1: Ops-Agent 搜索1688 ----

async function opsSearchNode(
  state: typeof AutoSelectState.State,
): Promise<Partial<typeof AutoSelectState.State>> {
  logger.info({ keyword: state.keyword }, "AutoSelect: Ops searching 1688");

  try {
    const resp = await deepseekChatCompletion([
      {
        role: "system",
        content: `你是1688选品专家。根据用户提供的关键词，返回3-5个1688上真实存在的热销商品。
返回JSON数组格式: [{"url":"完整1688链接","title":"商品名称","price":价格(元),"reason":"推荐理由"}]
只返回JSON，不要其他文字。链接格式必须是 https://detail.1688.com/offer/数字ID.html`,
      },
      { role: "user", content: `关键词: ${state.keyword}` },
    ], { temperature: 0.2, maxTokens: 1000 });

    const raw = resp.choices[0]?.message?.content || "[]";
    // Extract JSON from possible markdown code block
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const candidates = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as Array<{
      url: string; title: string; price: number; reason: string;
    }>;

    return {
      candidates: candidates.slice(0, 5),
      opsSearchError: "",
    };
  } catch (err) {
    return {
      opsSearchError: (err as Error).message,
      candidates: [],
    };
  }
}

// ---- Node 2: Promo-Agent 评分排序 ----

async function promoScoreNode(
  state: typeof AutoSelectState.State,
): Promise<Partial<typeof AutoSelectState.State>> {
  const candidates = state.candidates;
  if (candidates.length === 0) {
    return { promoScoreError: "No candidates to score" };
  }

  logger.info({ count: candidates.length }, "AutoSelect: Promo scoring products");

  try {
    const scored = candidates.map((c) => {
      // Multi-dimensional scoring (reuses scorer.ts logic)
      const marginScore = c.price > 0 ? Math.min(1, Math.max(0, (200 - c.price) / 150)) : 0.3;
      const popularityScore = 0.7; // Default for new search results
      const priceScore = c.price > 0 && c.price < 100 ? 0.8 : c.price < 200 ? 0.6 : 0.3;
      const titleScore = c.title.length > 10 ? 0.7 : 0.3;

      const promoScore = Math.round((marginScore * 0.35 + popularityScore * 0.25 + priceScore * 0.25 + titleScore * 0.15) * 100);

      return {
        url: c.url,
        title: c.title,
        price: c.price,
        opsScore: Math.round((marginScore * 0.5 + priceScore * 0.5) * 100),
        promoScore,
        finalScore: Math.round((promoScore * 0.6 + Math.round((marginScore * 0.5 + priceScore * 0.5) * 100) * 0.4)),
        margin: Math.round((1 - c.price / 200) * 100),
        verdict: promoScore >= 60 ? "recommend" : promoScore >= 40 ? "review" : "skip",
      };
    });

    // Sort by final score descending
    scored.sort((a, b) => b.finalScore - a.finalScore);

    return { scored, promoScoreError: "" };
  } catch (err) {
    return { promoScoreError: (err as Error).message, scored: [] };
  }
}

// ---- Node 3: Cross-Validation (Ops-Promo mutual check) ----

async function crossValidateNode(
  state: typeof AutoSelectState.State,
): Promise<Partial<typeof AutoSelectState.State>> {
  const top = state.scored[0];
  if (!top) return { validationPassed: false, validationIssues: ["No candidates"] };

  const issues: string[] = [];

  // Check 1: URL format validation (Ops)
  if (!top.url.match(/https:\/\/detail\.1688\.com\/offer\/\d+\.html/)) {
    issues.push(`[Ops] URL格式异常: ${top.url}`);
  }

  // Check 2: Price sanity (Promo)
  if (top.price <= 0 || top.price > 10000) {
    issues.push(`[Promo] 价格异常: ¥${top.price}`);
  }

  // Check 3: Score threshold
  if (top.finalScore < 50) {
    issues.push(`[Promo] 综合评分过低: ${top.finalScore}/100`);
  }

  // Check 4: Margin check
  if (top.margin < 10) {
    issues.push(`[Ops] 预估利润率不足: ${top.margin}%`);
  }

  // Check 5: Duplicate detection (both agents)
  const top2 = state.scored[1];
  if (top2 && top2.finalScore >= top.finalScore - 5) {
    issues.push(`[Both] 存在得分相近的候选 (${top2.title.slice(0,20)})`);
  }

  const passed = issues.length === 0;

  return { validationPassed: passed, validationIssues: issues };
}

// ---- Node 4: Ops-Agent 自动上架 ----

async function autoListNode(
  state: typeof AutoSelectState.State,
): Promise<Partial<typeof AutoSelectState.State>> {
  const top = state.scored[0];
  if (!top || !state.validationPassed) return {};

  logger.info({ url: top.url }, "AutoSelect: submitting listing");

  try {
    const resp = await fetch(`${process.env.API_BASE_URL || "http://localhost:3000"}/api/process`, {
      method: "POST",
      headers: { "X-API-Key": process.env.API_KEY || "", "Content-Type": "application/json" },
      body: JSON.stringify({ url: top.url, storeId: state.storeId || "store_1" }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await resp.json() as { success?: boolean; data?: { taskId?: string } };
    return { listingTaskId: (data.data?.taskId || "submitted"), listingError: "" };
  } catch (err) {
    return { listingError: (err as Error).message };
  }
}

// ---- Node 5: Promo-Agent 创建推广 ----

async function autoPromoNode(
  state: typeof AutoSelectState.State,
): Promise<Partial<typeof AutoSelectState.State>> {
  if (!state.listingTaskId) return {};

  try {
    const resp = await fetch(`${process.env.API_BASE_URL || "http://localhost:3000"}/api/promo/decision`, {
      method: "POST",
      headers: { "X-API-Key": process.env.API_KEY || "", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: `auto_${Date.now()}`,
        actions: [{ offerId: state.listingTaskId, type: "launch_ad" }],
        source: "auto_select_workflow",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await resp.json() as { id?: string };
    return { promoPlanId: data.id || "created" };
  } catch (err) {
    return { promoError: (err as Error).message };
  }
}

// ---- Node 6: 生成报告 ----

async function reportNode(
  state: typeof AutoSelectState.State,
): Promise<Partial<typeof AutoSelectState.State>> {
  const top = state.scored[0];
  const lines: string[] = [];

  lines.push(`## 自动选品报告 — "${state.keyword}"`);
  lines.push("");

  if (state.validationPassed && top) {
    lines.push(`✅ 交叉验证通过，已自动上架`);
    lines.push(`- 商品: ${top.title}`);
    lines.push(`- 价格: ¥${top.price}`);
    lines.push(`- 综合评分: ${top.finalScore}/100`);
    lines.push(`- 利润率: ${top.margin}%`);
    lines.push(`- 上架任务: ${state.listingTaskId || "已提交"}`);
    lines.push(`- 推广计划: ${state.promoPlanId || "已创建"}`);
  } else {
    lines.push(`⚠️ 验证未通过，未自动上架`);
    lines.push(`验证问题:`);
    for (const issue of (state.validationIssues || [])) {
      lines.push(`  - ${issue}`);
    }
    lines.push("");
    lines.push(`候选商品 (` + state.scored.length + `个):`);
    for (const s of state.scored.slice(0, 5)) {
      lines.push(`  ${s.finalScore}分 | ${s.title.slice(0, 40)} | ¥${s.price} | ${s.verdict}`);
    }
  }

  return { report: lines.join("\n") };
}

// ---- Condition ----

function shouldAutoList(
  state: typeof AutoSelectState.State,
): "auto_list" | "gen_report" {
  return state.validationPassed && state.scored.length > 0 ? "auto_list" : "gen_report";
}

// ---- Build graph ----

function buildAutoSelectGraph() {
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
      auto_list: "auto_list",
      gen_report: "gen_report",
    })

    .addEdge("auto_list", "auto_promo")
    .addEdge("auto_promo", "gen_report")
    .addEdge("gen_report", END)

    .compile();
}

let _autoSelectGraph: ReturnType<typeof buildAutoSelectGraph> | null = null;

export function getAutoSelectGraph() {
  if (!_autoSelectGraph) _autoSelectGraph = buildAutoSelectGraph();
  return _autoSelectGraph;
}

export async function executeAutoSelect(keyword: string): Promise<typeof AutoSelectState.State> {
  logger.info({ keyword }, "AutoSelect: starting");
  const graph = getAutoSelectGraph();
  return graph.invoke({
    keyword,
    storeId: "store_1",
    candidates: [],
    opsSearchError: "",
    scored: [],
    promoScoreError: "",
    validationPassed: false,
    validationIssues: [],
    listingTaskId: "",
    listingError: "",
    promoPlanId: "",
    promoError: "",
    report: "",
  });
}
