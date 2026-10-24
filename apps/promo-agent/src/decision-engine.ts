import type { FeishuBot } from "@onzo/feishu-bot";
import type { ApiConfig } from "./api-client.js";
import { promoApi, competitorApi } from "./api-client.js";
import { threatWeightedAverage } from "./competitor-threat.js";
import { logger } from "@onzo/logger";
import { crossValidate, type CrossValidationResult } from "./cross-validator.js";
import { generateCopy, applyCopy } from "./copywriter.js";
// astra 校验层（GPT astra 定价方案 2026-10）：planActions 之后、executePlan 之前拦截/修正向下调价
import {
  applyAstraGuard, loadAstraState, saveAstraState, recordAstraTrial, type AstraState,
} from "./astra-guard.js";
import { auditText } from "./compliance/index.js";
import { decisionCycleCounter, productScoreGauge, actionCounter, dailyActionGauge } from "./metrics.js";
import {
  type ProductScore,
  scoreMargin, scorePriceAdvantage, scoreStock, scoreSalesGrowth, scoreRating, getRecommendation,
} from "./scorer.js";
import {
  calculateUnitEconomics, effectivePriceRub, priceForTargetMargin, unitEconomicsConfigFromEnv,
} from "./unit-economics.js";

// ---- 飞书卡片构建 ----

function buildPromoCard(plan: DecisionPlan): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  const topProducts = plan.products.filter((p) => p.recommendation !== "skip").slice(0, 5);

  if (topProducts.length > 0) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: "🧠 **推广优先级排行**" } });
    for (const p of topProducts) {
      const emoji = p.recommendation === "copy" ? "✍️"
        : p.recommendation === "pricing" ? "💰"
        : p.recommendation === "copy_and_pricing" ? "🎯" : "⏭";
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: `${emoji} **${p.name.slice(0, 30)}** — ${p.totalScore}分\n利润${p.breakdown.margin} | 价格${p.breakdown.priceAdvantage} | 库存${p.breakdown.stock}`,
        },
      });
    }
  }

  if (plan.crossValidation?.issues.length) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: `🔍 验证问题:\n${plan.crossValidation.issues.map((i) => `• ${i}`).join("\n")}` } });
  }

  if (plan.actions.length > 0 && plan.status === "validated") {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "action",
      actions: [
        { tag: "button", text: { tag: "plain_text", content: "✅ 执行计划" }, type: "primary", value: { action: "execute_plan", planId: plan.id } },
        { tag: "button", text: { tag: "plain_text", content: "❌ 取消" }, type: "danger", value: { action: "cancel_plan", planId: plan.id } },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `📋 推广决策 ${plan.id.slice(-8)}` },
      template: plan.status === "failed" ? "red" : "blue",
    },
    elements,
  };
}

// ============================================================
// 类型定义
// ============================================================

export interface PlannedAction {
  offerId: string;
  name: string;
  storeId?: string;
  storeName?: string;
  type: "copy" | "pricing" | "copy_and_pricing";
  suggestedPrice?: number;
  currentPrice: number;
  priority: number; // 1=highest
  reason: string;
  priceReason?: "competitor_drop" | "competitor_raise" | "profit_repair" | "trial_revert";
}

export interface ActionResult {
  offerId: string;
  name: string;
  type: "copy" | "pricing" | "copy_and_pricing";
  success: boolean;
  message: string;
  appliedAt: string;
}

export interface DecisionPlan {
  id: string;
  createdAt: string;
  products: ProductScore[];
  actions: PlannedAction[];
  crossValidation: CrossValidationResult | null;
  status: "pending" | "validated" | "executing" | "completed" | "failed";
  executedAt?: string;
  results?: ActionResult[];
}

// ============================================================
// 配置
// ============================================================

const DECISION_INTERVAL_HOURS = parseInt(process.env.PROMO_DECISION_INTERVAL_HOURS || "24", 10);
const DECISION_INTERVAL_MS = DECISION_INTERVAL_HOURS * 60 * 60 * 1000;
const MAX_DAILY_AUTO_ACTIONS = parseInt(process.env.PROMO_MAX_DAILY_ACTIONS || "10", 10);
const SCORE_THRESHOLD = parseInt(process.env.PROMO_SCORE_THRESHOLD || "40", 10);

// 评分权重
const WEIGHT_MARGIN = 0.30;
const WEIGHT_PRICE_ADV = 0.25;
const WEIGHT_STOCK = 0.20;
const WEIGHT_SALES_GROWTH = 0.15;
const WEIGHT_RATING = 0.10;

// ============================================================
// 状态
// ============================================================

let decisionTimer: ReturnType<typeof setInterval> | null = null;
let autoDecisionEnabled = process.env.PROMO_AUTO_DECISION === "true";
let currentPlan: DecisionPlan | null = null;
let dailyActionCount = 0;
let dailyActionDate = "";
let lastSalesByOffer = new Map<string, { recent: number; prev: number }>();
/** 每商品每日调价记录（key: `${YYYY-MM-DD}:${offerId}`）——同一商品每日最多调价 1 次 */
const dailyPriceAdjustments = new Set<string>();

// ---- astra 校验层状态（GPT astra 定价方案）----
/** 总开关：默认启用；PROMO_ASTRA_GUARD=false 显式关闭（紧急回退用） */
const ASTRA_GUARD_ENABLED = process.env.PROMO_ASTRA_GUARD !== "false";
/** 状态落盘：降价试验要跨 14 天观察期（条款5），进程重启不能丢 */
const ASTRA_STATE_FILE = process.env.PROMO_ASTRA_STATE_FILE || "data/astra-guard-state.json";
const astraState: AstraState = loadAstraState(ASTRA_STATE_FILE);
/** 有利指数 GREEN SKU（条款3）：Ozon 无公开 API，运营从后台「搜索推广」页人工维护，
 *  env PROMO_GREEN_OFFERS 逗号分隔注入；默认空集 = 全部无 GREEN（流量增益按 0 计，最保守） */
const greenOffers = new Set(
  (process.env.PROMO_GREEN_OFFERS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

export function isAutoDecisionEnabled(): boolean {
  return autoDecisionEnabled;
}

export function setAutoDecisionEnabled(enabled: boolean): void {
  autoDecisionEnabled = enabled;
  logger.info({ enabled }, "Auto decision toggled");
}

export function getCurrentPlan(): DecisionPlan | null {
  return currentPlan;
}

// ============================================================
// 生命周期
// ============================================================

export function startDecisionEngine(bot: FeishuBot, chatId: string, config: ApiConfig): void {
  if (decisionTimer) return;
  logger.info({ intervalMs: DECISION_INTERVAL_MS }, "Decision engine started");

  runDecisionCycle(bot, chatId, config).catch((err) => {
    logger.error({ err }, "Initial decision cycle failed");
  });

  decisionTimer = setInterval(() => {
    runDecisionCycle(bot, chatId, config).catch((err) => {
      logger.error({ err }, "Decision cycle failed");
    });
  }, DECISION_INTERVAL_MS);
}

export function stopDecisionEngine(): void {
  if (decisionTimer) {
    clearInterval(decisionTimer);
    decisionTimer = null;
  }
  logger.info("Decision engine stopped");
}

// ============================================================
// 核心流程
// ============================================================

export async function runDecisionCycle(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
): Promise<void> {
  if (!autoDecisionEnabled) {
    logger.info("Decision cycle skipped — auto decision disabled");
    return;
  }

  // 1. 重置每日计数（跨日清零）
  resetDailyCountIfNeeded();

  // 2. 评分
  const scored = await scoreAllProducts(config);

  // 无可评分商品 — 抑制空卡片，本轮直接结束（无副作用，不计 metrics）
  if (scored.length === 0) {
    logger.info("No products to score — card suppressed");
    return;
  }

  // 3. 规划
  const actions = planActions(scored);

  // 3.5 astra 校验层（GPT astra 定价方案）：planActions 输出后、executePlan 执行前，只做拦截/修正——
  // 条款1 零单不降价 / 条款2 有优势不降价 / 条款3 g_BE 盈亏平衡 / 条款4 RED 分级 / 条款5 止损回退
  const guardedActions = ASTRA_GUARD_ENABLED
    ? applyAstraGuard(actions, scored, {
        sales14d: (offerId) => lastSalesByOffer.get(offerId),
        isAdjustedToday: (offerId) =>
          dailyPriceAdjustments.has(`${new Date().toISOString().slice(0, 10)}:${offerId}`),
        greenOffers,
        state: astraState,
      })
    : actions;
  if (ASTRA_GUARD_ENABLED) saveAstraState(ASTRA_STATE_FILE, astraState); // 零单周期计数/试验留档每轮有更新

  // 3.6 文案停用期间剔除纯 copy 动作——no-op 文案动作会占满每日执行名额导致 pricing 饿死
  // （2026-10-22 首轮实证：15 动作截断至 10 全为 copy skip，pricing 动作一个都没轮到）
  const effectiveActions = process.env.PROMO_COPY_ENABLED === "false"
    ? guardedActions.filter((a) => a.type !== "copy")
    : guardedActions;

  // 4. 交叉验证
  const crossValidation = await crossValidate(config, dailyActionCount);

  // 5. 构建计划
  const plan: DecisionPlan = {
    id: `plan_${Date.now()}`,
    createdAt: new Date().toISOString(),
    products: scored,
    actions: effectiveActions,
    crossValidation,
    status: crossValidation.passed ? "validated" : "pending",
  };

  currentPlan = plan;

  // 6. 验证未通过 → 报告 + 不执行
  if (!crossValidation.passed) {
    plan.status = "failed";
    decisionCycleCounter.inc({ status: "failed" });
    await bot.sendPromoCard(chatId, buildPromoCard(plan)).catch(() => {});
    return;
  }

  // 6.5 无动作不发卡片（2026-08-16：每 4h 雷同卡片刷屏无信息量）
  // 有动作（调价/文案）才执行+发卡片；无动作仅记日志。
  if (plan.actions.length === 0) {
    logger.info({ scored: scored.length }, "No actions planned — card suppressed");
    plan.status = "completed";
    return;
  }

  // 7. 验证通过 → 检查每日限额，超限截断
  if (dailyActionCount >= MAX_DAILY_AUTO_ACTIONS) {
    logger.warn("Daily action limit reached, skipping execution");
    plan.status = "completed";
    plan.results = [{
      offerId: "", name: "", type: "pricing", success: false,
      message: `今日已达上限 (${MAX_DAILY_AUTO_ACTIONS}次)`, appliedAt: new Date().toISOString(),
    }];
    await bot.sendPromoCard(chatId, buildPromoCard(plan)).catch(() => {});
    return;
  }

  // 8. 执行 plan
  plan.status = "executing";
  plan.results = await executePlan(bot, chatId, config, plan);
  plan.executedAt = new Date().toISOString();
  plan.status = "completed";

  decisionCycleCounter.inc({ status: plan.status });
  dailyActionGauge.set(dailyActionCount);

  // 9. 发送报告 — 使用飞书卡片
  const card = buildPromoCard(plan);
  if (plan.status === "completed" && plan.results?.length) {
    (card.elements as Array<Record<string, unknown>>).push(
      { tag: "hr" },
      { tag: "div", text: { tag: "lark_md", content: plan.results.map((r) => `${r.success ? "✅" : "❌"} ${r.name}: ${r.message}`).join("\n") } },
    );
  }
  await bot.sendPromoCard(chatId, card).catch(() => {});
}

// ============================================================
// 2. 评分算法
// ============================================================

export async function scoreAllProducts(config: ApiConfig): Promise<ProductScore[]> {
  // 获取所有活跃店铺
  const [fxData, storesData, orders14d] = await Promise.all([
    promoApi.exchangeRate(config).catch(() => null),
    promoApi.stores(config).catch(() => null),
    promoApi.orders(config, 14).catch(() => null),
  ]);

  const rate = Number((fxData as Record<string, unknown>)?.rate || 0);
  const rawOrders = orders14d as Record<string, unknown> | null;
  let orders: Array<Record<string, unknown>> = [];
  let ordersAvailable = false;
  if (rawOrders && Object.prototype.hasOwnProperty.call(rawOrders, "orders")) {
    if (Array.isArray(rawOrders.orders)) {
      orders = rawOrders.orders as Array<Record<string, unknown>>;
      ordersAvailable = true;
    }
  } else if (rawOrders && Array.isArray(rawOrders.data)) {
    orders = rawOrders.data as Array<Record<string, unknown>>;
    ordersAvailable = true;
  }
  if (!(rate > 0) || !Number.isFinite(rate)) logger.error("Exchange rate unavailable — all pricing actions blocked");
  if (!ordersAvailable) logger.error("Orders unavailable — all pricing actions blocked");
  const stores = (storesData as { items?: Array<{ storeId: string; storeName: string; active: number }> })?.items || [];

  // 从所有活跃店铺获取商品
  const allItems: Array<Record<string, unknown>> = [];
  const activeStores = stores.filter((s) => s.active !== 0);
  const storeList = activeStores.length > 0 ? activeStores : [{ storeId: "store_1", storeName: "Default" }];

  for (const store of storeList) {
    try {
      const storeConfig = { ...config, storeId: store.storeId };
      const products = await promoApi.products(storeConfig).catch(() => null);
      const items = (products as { items?: Array<Record<string, unknown>> })?.items || [];
      for (const item of items) {
        allItems.push({ ...item, _storeId: store.storeId, _storeName: store.storeName });
      }
    } catch { /* skip failed store */ }
  }

  if (allItems.length === 0) {
    logger.info("No products to score across all stores");
    return [];
  }

  // 从订单数据构建每个商品的近7天/前7天销量映射
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  // offerId → { recent: number, prev: number }
  const salesByOffer = new Map<string, { recent: number; prev: number }>();

  for (const order of orders) {
    // createdAt 可能为 null（v4 订单列表无 created_at，老同步行留 NULL），回退 synced_at（同步时间≈下单时间，14d 分桶够用）
    const createdAt = String(order.createdAt || order.created_at || order.synced_at || "");
    const orderDate = new Date(createdAt).getTime();
    if (isNaN(orderDate)) continue;

    const ageDays = (now - orderDate) / DAY_MS;
    // 订单中的商品列表；/api/orders 行是 products_json 字符串（内含 offerId），需解析
    let orderItems = (order.items || order.products || []) as Array<Record<string, unknown>>;
    if (orderItems.length === 0 && typeof order.products_json === "string") {
      try { orderItems = JSON.parse(order.products_json) as Array<Record<string, unknown>>; } catch { orderItems = []; }
    }
    for (const oi of orderItems) {
      const oid = String(oi.offerId || oi.offer_id || "");
      if (!oid) continue;
      const entry = salesByOffer.get(oid) || { recent: 0, prev: 0 };
      if (ageDays <= 7) {
        entry.recent++;
      } else if (ageDays <= 14) {
        entry.prev++;
      }
      salesByOffer.set(oid, entry);
    }
  }
  lastSalesByOffer = salesByOffer;
  logger.info({ orderCount: orders.length, trackedOffers: salesByOffer.size }, "Sales growth data prepared");

  const eligible = allItems.filter((item) => String(item.offerId || item.offer_id || "").trim());
  const scored: ProductScore[] = [];

  for (const item of eligible) {
    const offerId = String(item.offerId || item.offer_id || "");
    const name = String(item.name || item.title || offerId).slice(0, 50);
    const cost = Number(item.cost || 0);
    const actionPriceRub = Number(item.actionPriceRub || 0);
    const currentPrice = effectivePriceRub(Number(item.price || 0), actionPriceRub);
    const stock = Number(item.stock ?? item.quantity ?? 0);
    const weightG = Number(item.weight || 0) * 1000;
    const economicsConfig = unitEconomicsConfigFromEnv(offerId);
    const economics = calculateUnitEconomics({ priceRub: currentPrice, costCny: cost, weightG, exchangeRate: rate, offerId, config: economicsConfig });
    const pricingBlockers = [...economics.pricingBlockers];
    if (!(stock > 0)) pricingBlockers.push("OUT_OF_STOCK");
    if (!ordersAvailable) pricingBlockers.push("ORDERS_UNAVAILABLE");
    if (pricingBlockers.length > 0) logger.warn({ offerId, pricingBlockers }, "Product pricing data incomplete");

    let competitorAvg = currentPrice;
    let pricingCompetitorAvg: number | null = null;
    let pricingCompetitorCapturedAt: string | null = null;
    let latestPreciseCapturedAt: string | null = null;
    try {
      const priceData = await competitorApi.getPrices(config, offerId, 3);
      const all = priceData.prices || [];
      const precise = all.filter((p) => p.competitorUrl);
      const preciseTimes = precise.map((p) => new Date(p.capturedAt).getTime()).filter(Number.isFinite);
      if (preciseTimes.length > 0) latestPreciseCapturedAt = new Date(Math.max(...preciseTimes)).toISOString();
      const displayCandidates = precise.length > 0 ? precise : all;
      const displayWeighted = threatWeightedAverage(displayCandidates, currentPrice);
      if (displayWeighted > 0) competitorAvg = displayWeighted;
      const freshPrecise = precise.filter((p) => {
        const time = new Date(p.capturedAt).getTime();
        return Number.isFinite(time) && now - time >= 0 && now - time <= DAY_MS;
      });
      const pricingWeighted = threatWeightedAverage(freshPrecise, currentPrice);
      if (pricingWeighted > 0) {
        pricingCompetitorAvg = pricingWeighted;
        const freshTimes = freshPrecise.map((p) => new Date(p.capturedAt).getTime());
        pricingCompetitorCapturedAt = new Date(Math.max(...freshTimes)).toISOString();
      }
    } catch (err) {
      logger.warn({ err, offerId }, "Competitor snapshots unavailable — price changes requiring competitors blocked");
    }
    const hasFreshPreciseCompetitor = pricingCompetitorAvg !== null;

    const salesData = salesByOffer.get(offerId);
    let salesGrowth7d = 0;
    if (salesData) {
      const { recent, prev } = salesData;
      salesGrowth7d = prev > 0 ? ((recent - prev) / prev) * 100 : (recent > 0 ? 100 : 0);
    }
    const rating = Number(item.rating || item.productRating || 0);
    const marginPercent = economics.marginPercent;
    const marginScore = scoreMargin(marginPercent);

    // 有可定价新鲜均价时推荐与评分同口径；否则旧数据仅作展示，planActions 不会生成竞品调价。
    const scoringCompetitorAvg = pricingCompetitorAvg ?? competitorAvg;
    const priceAdvantage = scoringCompetitorAvg > 0
      ? ((scoringCompetitorAvg - currentPrice) / scoringCompetitorAvg) * 100
      : 0;
    const priceAdvScore = scorePriceAdvantage(priceAdvantage);

    // 库存评分
    const stockScore = scoreStock(stock);

    // 销量增长评分
    const salesScore = scoreSalesGrowth(salesGrowth7d);

    // 评分
    const ratingScore = scoreRating(rating);

    // 加权总分
    const totalScore = Math.round(
      marginScore * WEIGHT_MARGIN * 100 +
      priceAdvScore * WEIGHT_PRICE_ADV * 100 +
      stockScore * WEIGHT_STOCK * 100 +
      salesScore * WEIGHT_SALES_GROWTH * 100 +
      ratingScore * WEIGHT_RATING * 100
    );

    // 推荐策略
    const { recommendation, reason } = getRecommendation(
      totalScore, marginPercent, priceAdvantage,
    );

    scored.push({
      offerId,
      name,
      storeId: String(item._storeId || ""),
      storeName: String(item._storeName || ""),
      cost,
      currentPrice,
      stock,
      marginPercent,
      competitorAvg,
      priceAdvantage: Math.round(priceAdvantage * 10) / 10,
      salesGrowth7d: Math.round(salesGrowth7d * 10) / 10,
      rating: Math.round(rating * 10) / 10,
      totalScore,
      costRub: Math.round(economics.costRub * 100) / 100,
      logisticsRub: Math.round(economics.logisticsRub * 100) / 100,
      packagingRub: Math.round(economics.packagingRub * 100) / 100,
      fixedCostRub: Math.round(economics.fixedCostRub * 100) / 100,
      unitProfitRub: Math.round(economics.unitProfitRub * 100) / 100,
      weightG,
      exchangeRate: rate,
      pricingBlockers,
      hasFreshPreciseCompetitor,
      latestPreciseCapturedAt,
      pricingCompetitorAvg,
      pricingCompetitorCapturedAt,
      floorPrice: Math.ceil(economics.floorPrice * 100) / 100,
      breakdown: {
        margin: Math.round(marginScore * 100),
        priceAdvantage: Math.round(priceAdvScore * 100),
        stock: Math.round(stockScore * 100),
        salesGrowth: Math.round(salesScore * 100),
        rating: Math.round(ratingScore * 100),
      },
      recommendation,
      reason: actionPriceRub > 0 ? `${reason}（含促销价口径）` : reason,
    });

    // 避免 API 密集
    await sleep(200);
  }

  // 按总分降序
  scored.sort((a, b) => b.totalScore - a.totalScore);

  // Update metrics
  for (const p of scored) {
    productScoreGauge.set({ offerId: p.offerId, recommendation: p.recommendation }, p.totalScore);
  }

  // RAG Playbook enrichment
  for (const product of scored) {
    if (product.recommendation === "skip") continue;
    try {
      const ragResp = await fetch(`${config.apiBase}/api/rag/playbook/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
        body: JSON.stringify({
          query: `${product.recommendation} ${product.name} 利润率${product.marginPercent}%`,
          scenario: product.recommendation === "pricing" ? "pricing" : "promotion",
          topK: 2,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (ragResp.ok) {
        const ragData = await ragResp.json() as { results?: Array<{ content: string }> };
        if (ragData.results?.length) {
          product.reason += ` | 参考: ${ragData.results[0].content.slice(0, 80)}`;
        }
      }
    } catch { /* RAG unavailable */ }
  }

  logger.info({ scored: scored.length }, "Product scoring complete");
  return scored;
}

// Scoring functions and types imported from ./scorer.js

// ============================================================
// 3. 行动规划
// ============================================================

export function planActions(scored: ProductScore[]): PlannedAction[] {
  const actions: PlannedAction[] = [];

  for (const product of scored) {
    const needsProfitRepair = product.recommendation !== "copy" && product.marginPercent < 20;
    if (product.recommendation === "skip" || (product.totalScore < SCORE_THRESHOLD && !needsProfitRepair)) continue;

    let suggestedPrice: number | undefined;
    let priceReason: PlannedAction["priceReason"];
    if (product.recommendation !== "copy") {
      const floor = product.floorPrice;
      const cur = product.currentPrice;
      const pricingCompetitorAvg = product.pricingCompetitorAvg;
      const pricingPriceAdvantage = pricingCompetitorAvg !== null && pricingCompetitorAvg > 0 && cur > 0
        ? (pricingCompetitorAvg - cur) / pricingCompetitorAvg * 100
        : null;
      if (product.marginPercent < 20) {
        const config = unitEconomicsConfigFromEnv(product.offerId);
        const ogl = { baseFixedCostRub: product.costRub + product.packagingRub, weightG: product.weightG, exchangeRate: product.exchangeRate };
        suggestedPrice = Math.ceil(Math.max(floor, priceForTargetMargin(ogl.baseFixedCostRub, config.astraNetMarginRate, config, ogl)));
        priceReason = "profit_repair";
      } else if (pricingPriceAdvantage !== null && pricingPriceAdvantage < -5) {
        suggestedPrice = Math.round(Math.max(floor, Math.min(cur, (pricingCompetitorAvg as number) * 0.97)));
        priceReason = "competitor_drop";
      } else if (pricingPriceAdvantage !== null && pricingPriceAdvantage > 15) {
        suggestedPrice = Math.round(Math.min(pricingCompetitorAvg as number, cur * 1.05));
        priceReason = "competitor_raise";
      }
      if (suggestedPrice !== undefined) {
        if (priceReason === "profit_repair" && suggestedPrice <= cur) {
          logger.warn({ offerId: product.offerId, reason: "PROFIT_REPAIR_NOT_UPWARD", currentPrice: cur, suggestedPrice }, "Pricing action blocked");
          if (product.recommendation === "copy_and_pricing") {
            actions.push({
              offerId: product.offerId, name: product.name, storeId: product.storeId, storeName: product.storeName,
              type: "copy", currentPrice: cur, priority: actions.length + 1,
              reason: `${product.reason} | PROFIT_REPAIR_NOT_UPWARD，保留文案`,
            });
          }
          continue;
        }
        const dataBlockers = product.pricingBlockers || [];
        const competitorRequired = suggestedPrice < cur || priceReason === "competitor_raise";
        const competitorBlocked = competitorRequired && product.pricingCompetitorAvg === null;
        if (dataBlockers.length > 0 || competitorBlocked) {
          const reason = competitorBlocked ? "NO_FRESH_PRECISE_COMPETITOR" : dataBlockers.join(",");
          logger.warn({ offerId: product.offerId, reason, suggestedPrice }, "Pricing action blocked");
          if (product.recommendation === "copy_and_pricing") {
            actions.push({
              offerId: product.offerId, name: product.name, storeId: product.storeId, storeName: product.storeName,
              type: "copy", currentPrice: cur, priority: actions.length + 1,
              reason: `${product.reason} | 调价阻断: ${reason}`,
            });
          }
          continue;
        }
        if (!Number.isFinite(suggestedPrice) || suggestedPrice < floor) {
          logger.warn({ offerId: product.offerId, suggestedPrice, floor }, "Suggested price below floor — skipping");
          continue;
        }
        if (suggestedPrice === Math.round(cur)) continue;
        let diffPct = Math.abs((suggestedPrice - cur) / cur);
        if (diffPct > 0.10) {
          const clamped = suggestedPrice < cur ? Math.ceil(cur * 0.90) : Math.floor(cur * 1.10);
          const validRepairStep = priceReason === "profit_repair" && suggestedPrice > cur && clamped > cur && clamped <= suggestedPrice;
          if (clamped < floor && !validRepairStep) {
            logger.warn({ offerId: product.offerId, clamped, floor }, "Clamped price below floor — skipping");
            continue;
          }
          logger.info({ offerId: product.offerId, from: cur, to: clamped, target: suggestedPrice },
            "Step pricing: clamp to 10% this cycle, converge later");
          suggestedPrice = clamped;
          diffPct = 0.10;
        }
        const today = new Date().toISOString().slice(0, 10);
        const adjustKey = `${today}:${product.offerId}`;
        if (dailyPriceAdjustments.has(adjustKey)) {
          logger.info({ offerId: product.offerId }, "Already adjusted today — skipping");
          continue;
        }
      }
    }

    const validSuggestedPrice = suggestedPrice !== undefined && Number.isFinite(suggestedPrice) && suggestedPrice > 0;
    if (product.recommendation === "pricing" && !validSuggestedPrice) {
      logger.warn({ offerId: product.offerId }, "Pricing recommendation without a finite suggested price — skipping");
      continue;
    }
    const keepOnlyCopy = product.recommendation === "copy_and_pricing" && !validSuggestedPrice;
    actions.push({
      offerId: product.offerId,
      name: product.name,
      storeId: product.storeId,
      storeName: product.storeName,
      type: keepOnlyCopy ? "copy" : product.recommendation,
      suggestedPrice: keepOnlyCopy ? undefined : suggestedPrice,
      currentPrice: product.currentPrice,
      priority: actions.length + 1,
      reason: keepOnlyCopy ? `${product.reason} | 无可执行调价，保留文案` : product.reason,
      priceReason: keepOnlyCopy ? undefined : priceReason,
    });
  }

  // A/B 分流：随机分配对照组
  if (process.env.PROMO_AB_TEST === "true") {
    const controlRatio = parseInt(process.env.PROMO_AB_CONTROL_RATIO || "30", 10);
    const abFiltered: PlannedAction[] = [];
    for (const action of actions) {
      const hash = simpleHash(action.offerId) % 100;
      if (hash < controlRatio) {
        // 对照组：不执行，记录原因
        logger.info({ offerId: action.offerId, hash }, "A/B test: assigned to control group");
        continue; // skip this action
      }
      abFiltered.push(action);
    }
    return abFiltered;
  }

  return actions;
}

function simpleHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ============================================================
// 4. 自动执行引擎
// ============================================================

/**
 * 执行计划中的所有操作
 * - copy: 生成文案 → 合规审计 → 上架
 * - pricing: 验证幅度 → 更新价格
 * - copy_and_pricing: 先 copy 后 pricing
 * 每个操作间隔 1 秒
 */
async function executePlan(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
  plan: DecisionPlan,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  // 按限额截断
  const remaining = MAX_DAILY_AUTO_ACTIONS - dailyActionCount;
  const executable = plan.actions.slice(0, remaining);

  if (executable.length < plan.actions.length) {
    logger.warn({ total: plan.actions.length, executable: executable.length }, "Actions truncated by daily limit");
  }

  for (const action of executable) {
    const appliedAt = new Date().toISOString();

    if (action.type === "copy") {
      results.push(await executeCopyAction(bot, config, chatId, action, appliedAt));
    } else if (action.type === "pricing") {
      results.push(await executePricingAction(config, action, appliedAt));
    } else if (action.type === "copy_and_pricing") {
      // 先 copy（文案优先，不影响价格），再 pricing
      results.push(await executeCopyAction(bot, config, chatId, action, appliedAt));
      await sleep(500); // 额外间隔
      results.push(await executePricingAction(config, action, appliedAt));
    }

    // 每个操作间隔 1 秒
    await sleep(1000);
  }

  // Metrics: record all action results
  for (const r of results) {
    actionCounter.inc({ type: r.type, result: r.success ? "success" : "failed" });
  }

  // 效果回溯：记录操作前的销量基准，供7天后评估增量
  for (const r of results) {
    if (!r.success) continue;
    const baseline = lastSalesByOffer.get(r.offerId);
    try {
      if (r.type === "pricing" || r.type === "copy_and_pricing") {
        const action = plan.actions.find((a) => a.offerId === r.offerId);
        await competitorApi.postEvent(config, {
          type: "pricing_applied",
          payload: {
            offerId: r.offerId,
            oldPrice: action?.currentPrice ?? 0,
            newPrice: action?.suggestedPrice ?? 0,
            appliedAt: r.appliedAt,
            baselineSales: baseline?.recent || 0,
          },
        });
      }
      if (r.type === "copy" || r.type === "copy_and_pricing") {
        await competitorApi.postEvent(config, {
          type: "copy_applied",
          payload: {
            offerId: r.offerId,
            appliedAt: r.appliedAt,
            baselineSales: baseline?.recent || 0,
          },
        });
      }
    } catch (err) {
      logger.warn({ err, offerId: r.offerId }, "Failed to record action event for backtracking");
    }
  }

  // Auto-save successful actions to RAG Playbook（串行+间隔防突发；429 按 Retry-After 重试一次）
  void (async () => {
    for (const result of results) {
      if (!result.success) continue;
      const payload = {
        title: `${result.type}操作: ${result.name}`,
        scenario: result.type === "pricing" ? "pricing" : "promotion",
        content: `商品: ${result.name}\n操作: ${result.type}\n原因: ${result.message}\n结果: 成功`,
        tags: [result.type, result.offerId],
        author: "auto_decision",
        priority: 1,
      };
      try {
        let resp = await fetch(`${config.apiBase}/api/rag/playbook`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        });
        if (resp.status === 429) {
          const waitSec = Math.min(Number(resp.headers.get("retry-after")) || 2, 10);
          await new Promise((s) => setTimeout(s, waitSec * 1000));
          resp = await fetch(`${config.apiBase}/api/rag/playbook`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5_000),
          });
        }
        if (!resp.ok) {
          logger.warn({ status: resp.status, offerId: result.offerId }, "Playbook write rejected");
        }
      } catch {
        // fire-and-forget：写库失败不影响决策结果
      }
      await new Promise((s) => setTimeout(s, 250)); // 间隔防同毫秒突发打爆限流桶
    }
  })();

  return results;
}

/** 文案优化：生成 → 审计 → 上架（网络错误重试1次） */
async function executeCopyAction(
  bot: FeishuBot,
  config: ApiConfig,
  chatId: string,
  action: PlannedAction,
  appliedAt: string,
): Promise<ActionResult> {
  // 2026-10-22 用户定调：全店文案已由 Kimi+GPT 统一精修上线，日常自动文案优化停用
  // （PROMO_COPY_ENABLED=false 时 copy/copy_and_pricing 的文案部分跳过，pricing 不受影响）
  if (process.env.PROMO_COPY_ENABLED === "false") {
    logger.info({ offerId: action.offerId }, "Copy action skipped — PROMO_COPY_ENABLED=false");
    return { offerId: action.offerId, name: action.name, type: "copy", success: false, message: "文案优化已停用（统一精修后关闭）", appliedAt };
  }
  try {
    // a. 生成文案（可重试）
    const copy = await withRetry(() => generateCopy(config, action.offerId, chatId));
    if (!copy) {
      return { offerId: action.offerId, name: action.name, type: "copy", success: false, message: "文案生成失败", appliedAt };
    }

    // b. 合规审计（不重试 — 业务错误）
    const titleAudit = auditText(copy.titleRu);
    const descAudit = auditText(copy.descriptionRu);

    if (!titleAudit.passed || !descAudit.passed) {
      const blocked = titleAudit.blockedCount + descAudit.blockedCount;
      // 把具体阻断词写进消息和日志 — 否则飞书只看到"N条阻断"，无法定位（2026-09-04 实证）
      const blockedDetails = [...titleAudit.findings, ...descAudit.findings]
        .filter((f) => f.violation.severity === "block")
        .map((f) => `"${f.violation.word}" (${f.violation.reason})`)
        .join("; ");
      logger.error({ offerId: action.offerId, blocked, blockedDetails }, "Copy blocked by compliance audit");
      return {
        offerId: action.offerId, name: action.name, type: "copy", success: false,
        message: `合规审计未通过: ${blocked}条阻断 [${blockedDetails}]`, appliedAt,
      };
    }

    // c. 上架（可重试）
    const result = await withRetry(() => applyCopy(bot, chatId, config, action.offerId));
    dailyActionCount++;
    logger.info({ offerId: action.offerId }, "Auto copy applied");
    return { offerId: action.offerId, name: action.name, type: "copy", success: true, message: result.slice(0, 200), appliedAt };
  } catch (err) {
    return { offerId: action.offerId, name: action.name, type: "copy", success: false, message: `异常: ${(err as Error).message}`, appliedAt };
  }
}

/** 价格调整：验证幅度 → 更新（网络错误重试1次） */
async function executePricingAction(
  config: ApiConfig,
  action: PlannedAction,
  appliedAt: string,
): Promise<ActionResult> {
  // 业务校验不重试
  if (!action.suggestedPrice || action.currentPrice <= 0) {
    return { offerId: action.offerId, name: action.name, type: "pricing", success: false, message: "缺少建议价或当前价无效", appliedAt };
  }

  const diffPct = Math.abs((action.suggestedPrice - action.currentPrice) / action.currentPrice);
  if (diffPct > 0.10) {
    logger.warn(
      { offerId: action.offerId, currentPrice: action.currentPrice, suggestedPrice: action.suggestedPrice, diffPct },
      "Pricing action rejected: diff exceeds 10% at execution",
    );
    return {
      offerId: action.offerId, name: action.name, type: "pricing", success: false,
      message: `调价幅度超限(10%): ${(diffPct * 100).toFixed(1)}%`, appliedAt,
    };
  }

  try {
    const newPrice = action.suggestedPrice as number; // narrowed by guard above
    await withRetry(() => promoApi.updatePrice(config, action.offerId, newPrice));
    dailyActionCount++;
    // 记录每商品每日调价（同日不再调该商品）
    const today = new Date().toISOString().slice(0, 10);
    dailyPriceAdjustments.add(`${today}:${action.offerId}`);
    // astra 条款5（嵌入执行后回读）：降价试验留档试验前价格，14d 无订单证据则回退；涨价/回退不记
    if (ASTRA_GUARD_ENABLED) {
      recordAstraTrial(astraState, action.offerId, action.currentPrice, newPrice);
      saveAstraState(ASTRA_STATE_FILE, astraState);
    }
    logger.info({ offerId: action.offerId, price: newPrice }, "Auto price updated");
    return {
      offerId: action.offerId, name: action.name, type: "pricing", success: true,
      message: `${action.currentPrice.toFixed(0)} → ${newPrice.toFixed(0)} ₽`, appliedAt,
    };
  } catch (err) {
    return { offerId: action.offerId, name: action.name, type: "pricing", success: false, message: `异常: ${(err as Error).message}`, appliedAt };
  }
}

/** 跨日重置计数器 */
function resetDailyCountIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyActionDate !== today) {
    dailyActionDate = today;
    dailyActionCount = 0;
    // key 带日期前缀，跨日后旧条目全部失效 — 不清理会在常驻进程无界累积（2026-09-04 审查）
    dailyPriceAdjustments.clear();
    logger.info("Daily action count reset");
  }
}

/** 网络错误判断 */
function isRetryableError(err: unknown): boolean {
  const msg = (err as Error).message?.toLowerCase() || "";
  // Ozon 业务拒绝（改价被平台驳回等）— 重试同样的请求只会再被拒，不算网络错误
  if (msg.includes("ozon price push failed")) return false;
  return (
    msg.includes("fetch failed") ||
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504")
  );
}

/** 网络错误重试：最多1次，间隔3秒 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isRetryableError(err)) {
      logger.warn({ err }, "Retrying after network error");
      await sleep(3000);
      return fn();
    }
    throw err;
  }
}

// ============================================================
// 5. 格式化报告
// ============================================================

export function formatDecisionReport(plan: DecisionPlan): string {
  const cv = plan.crossValidation;
  const lines: string[] = [
    `🧠 **自主决策报告**`,
    `🆔 ${plan.id}`,
    `⏰ ${plan.createdAt.slice(0, 19).replace("T", " ")}`,
    "",
  ];

  // 交叉验证
  if (cv) {
    lines.push(`🔍 **交叉验证** — ${cv.passed ? "✅ 通过" : "🚫 未通过"}`);
    if (cv.issues.length > 0) {
      cv.issues.forEach((i) => lines.push(`   • ${i}`));
    }
    lines.push("");
  }

  // 评分排行
  lines.push(`📊 **商品评分 Top 10** (共 ${plan.products.length} 件)`);
  lines.push("");
  plan.products.slice(0, 10).forEach((p, i) => {
    const rec = p.recommendation === "skip" ? "⏭" :
                p.recommendation === "copy" ? "📝" :
                p.recommendation === "pricing" ? "💰" : "🔧";
    lines.push(
      `${i + 1}. ${rec} ${p.storeName ? `🏪${p.storeName} | ` : ""}**${p.name}** — ${p.totalScore}分`,
      `   利润:${p.marginPercent}% | 价格优势:${p.priceAdvantage}% | 库存:${p.stock}`,
    );
  });

  // 行动建议
  if (plan.actions.length > 0) {
    lines.push("");
    lines.push(`🎯 **推荐操作** (${plan.actions.length} 项)`);
    plan.actions.forEach((a) => {
      const typeLabel = a.type === "pricing" ? "💰 调价" :
                         a.type === "copy" ? "📝 文案" : "🔧 调价+文案";
      const priceInfo = a.suggestedPrice
        ? `: ${a.currentPrice} → ${a.suggestedPrice} ₽`
        : "";
      lines.push(`   ${typeLabel}: ${a.storeName ? `🏪${a.storeName} | ` : ""}${a.name}${priceInfo}`);
    });
  }

  return lines.join("\n");
}

export function formatExecutionReport(plan: DecisionPlan): string {
  const lines = [
    `✅ **自主决策执行报告**`,
    `🆔 ${plan.id}`,
    `⏰ 执行时间: ${plan.executedAt?.slice(0, 19).replace("T", " ") || "—"}`,
    `📊 状态: ${plan.status}`,
    "",
  ];

  if (plan.results && plan.results.length > 0) {
    const successCount = plan.results.filter((r) => r.success).length;
    const failedCount = plan.results.filter((r) => !r.success).length;
    lines.push(`📋 **执行结果**: ✅${successCount} ❌${failedCount}`);
    lines.push("");
    plan.results.forEach((r) => {
      const icon = r.success ? "✅" : "❌";
      const typeLabel = r.type === "copy" ? "📝" : r.type === "pricing" ? "💰" : "🔧";
      lines.push(`   ${icon} ${typeLabel} ${r.name}: ${r.message}`);
    });
    lines.push("");
  }

  lines.push(
    `📈 今日已执行: ${dailyActionCount}/${MAX_DAILY_AUTO_ACTIONS}`,
    `🔄 下次决策: ${DECISION_INTERVAL_HOURS}小时后`,
    "",
    "📊 效果将在7天后自动评估，届时可在周报中查看增量数据",
  );

  return lines.join("\n");
}

// ============================================================
// 工具
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
