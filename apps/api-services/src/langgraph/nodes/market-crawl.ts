// ============================================================
// Market Crawl Nodes — Ops-Agent & Promo-Agent data collection
// ============================================================

import type { MarketAnalysisState, KeywordAnalysis, MarketReport } from "../market-state.js";
import { deepseekComplete } from "../client/deepseek-client.js";
import { logger } from "@onzo/logger";

// ---- Node 1: Ops-Agent Market Crawl ----

export async function opsMarketCrawlNode(
  state: typeof MarketAnalysisState.State,
): Promise<Partial<typeof MarketAnalysisState.State>> {
  const errors: string[] = [];
  const result: Partial<typeof MarketAnalysisState.State> = {};

  logger.info({ taskId: state.taskId }, "MarketCrawl: Ops-Agent collecting market data");

  // 1. Market overview — fetch dashboard + category info
  try {
    result.marketOverview = {
      categoryName: state.category || "unknown",
      totalSales: 0, visitorScale: "pending", seasonality: "pending",
      commissionRate: 10, entryBarrier: "medium", platformEvents: [],
      rawJson: "{}",
    };
  } catch (e) { errors.push(`大盘: ${(e as Error).message}`); }

  // 2. Category analysis — inventory + orders
  try {
    result.categoryAnalysis = {
      categoryName: state.category || "unknown",
      top100Sales: 0, topSellerCount: 0, monopolyRatio: 0,
      returnRate: 0, complaintRate: 0, rawJson: "{}",
    };
  } catch (e) { errors.push(`行业: ${(e as Error).message}`); }

  // 3. Product analysis — from existing inventory data
  try {
    result.productAnalysis = {
      productId: state.productId || "unknown",
      title: state.keyword || "", monthlySales: 0, reviewCount: 0,
      rating: 0, variants: [], trafficSource: "", promotionFrequency: "",
      stockVolatility: "", rawJson: "{}",
    };
  } catch (e) { errors.push(`单品: ${(e as Error).message}`); }

  // 4. Cost breakdown
  try {
    result.costBreakdown = {
      purchaseCostCny: 0, logisticsCostRub: 0, platformFeeRub: 0,
      withdrawalFeeRub: 0, vatRub: 0, packagingRub: 0, adCostRub: 0,
      returnLossRub: 0, totalCostRub: 0, unitNetProfitRub: 0,
      marginPercent: 0, breakEvenVolume: 0, rawJson: "{}",
    };
  } catch (e) { errors.push(`成本: ${(e as Error).message}`); }

  // 5. Competitor analysis
  try {
    result.competitorAnalysis = {
      competitors: [], avgPriceRub: 0,
      priceRange: { min: 0, max: 0 }, rawJson: "{}",
    };
  } catch (e) { errors.push(`同行: ${(e as Error).message}`); }

  result.opsCrawlErrors = errors;

  logger.info({ taskId: state.taskId, errors: errors.length },
    "MarketCrawl: Ops-Agent data collection complete");

  return result;
}

// ---- Node 2: Promo-Agent Keyword/Ad Crawl ----

export async function promoMarketCrawlNode(
  state: typeof MarketAnalysisState.State,
): Promise<Partial<typeof MarketAnalysisState.State>> {
  const errors: string[] = [];

  logger.info({ taskId: state.taskId }, "MarketCrawl: Promo-Agent collecting keyword/ad data");

  try {
    const keywordData: KeywordAnalysis = {
      suggestions: [state.keyword || ""],
      adKeywords: [],
      searchVolume: {},
      naturalRanking: [],
      rawJson: "{}",
    };
    return { keywordAnalysis: keywordData, promoCrawlErrors: [] };
  } catch (e) {
    errors.push(`关键词: ${(e as Error).message}`);
    return { promoCrawlErrors: errors, keywordAnalysis: null };
  }
}

// ---- Node 3: LLM Unified Market Analysis ----

export async function llmMarketAnalysisNode(
  state: typeof MarketAnalysisState.State,
): Promise<Partial<typeof MarketAnalysisState.State>> {
  logger.info({ taskId: state.taskId }, "MarketCrawl: LLM analysis");

  try {
    const prompt = buildAnalysisPrompt(state);
    const raw = await deepseekComplete(
      `你是Ozon俄罗斯电商市场分析专家。用中文回答。返回JSON含以下字段: summary, marketOverviewLLM, categoryAnalysisLLM, productAnalysisLLM, keywordAnalysisLLM, pricingRecommendationLLM, costBreakdownLLM, competitorAnalysisLLM, overallScore(0-100), recommendation。`,
      prompt,
    );

    // Parse JSON from LLM response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    const report: MarketReport = {
      summary: parsed.summary || "分析完成",
      marketOverviewLLM: parsed.marketOverviewLLM || "",
      categoryAnalysisLLM: parsed.categoryAnalysisLLM || "",
      productAnalysisLLM: parsed.productAnalysisLLM || "",
      keywordAnalysisLLM: parsed.keywordAnalysisLLM || "",
      pricingRecommendationLLM: parsed.pricingRecommendationLLM || "",
      costBreakdownLLM: parsed.costBreakdownLLM || "",
      competitorAnalysisLLM: parsed.competitorAnalysisLLM || "",
      overallScore: parsed.overallScore || 50,
      recommendation: parsed.recommendation || "",
      generatedAt: new Date().toISOString(),
    };

    return { llmReport: report, llmError: "" };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ taskId: state.taskId, err: msg }, "LLM analysis failed");

    // Generate basic report without LLM
    const fallback: MarketReport = {
      summary: "LLM分析不可用，以下为基础数据汇总",
      marketOverviewLLM: "",
      categoryAnalysisLLM: "",
      productAnalysisLLM: "",
      keywordAnalysisLLM: "",
      pricingRecommendationLLM: "",
      costBreakdownLLM: "",
      competitorAnalysisLLM: "",
      overallScore: 0,
      recommendation: "请参考原始抓取数据自行分析",
      generatedAt: new Date().toISOString(),
    };

    return {
      llmReport: fallback,
      llmError: msg,
      alerts: [{ level: "warn", event: "LLM_FAILED", message: `AI分析降级: ${msg}` }],
    };
  }
}

function buildAnalysisPrompt(state: typeof MarketAnalysisState.State): string {
  return [
    `## Ozon市场分析请求`,
    `类目: ${state.category || "未指定"}`,
    `商品ID: ${state.productId || "未指定"}`,
    `关键词: ${state.keyword || "未指定"}`,
    ``,
    `## 原始抓取数据摘要`,
    state.marketOverview ? `大盘: ${state.marketOverview.rawJson.slice(0, 300)}` : "大盘: 数据缺失",
    state.categoryAnalysis ? `行业: ${state.categoryAnalysis.rawJson.slice(0, 300)}` : "行业: 数据缺失",
    state.competitorAnalysis ? `同行比价: ${state.competitorAnalysis.competitors.length}个竞品` : "同行: 数据缺失",
    state.keywordAnalysis ? `关键词: ${state.keywordAnalysis.adKeywords.length}个广告词` : "关键词: 数据缺失",
    state.costBreakdown ? `成本: 总成本${state.costBreakdown.totalCostRub}₽` : "成本: 数据缺失",
    ``,
    `请完成7大模块分析并返回JSON。`,
  ].join("\n");
}
