import type { FeishuBot } from "@onzo/feishu-bot";
import type { ApiConfig } from "./api-client.js";
import { promoApi, competitorApi } from "./api-client.js";
import { logger } from "@onzo/logger";

// ---- 类型 ----

export interface PricingSuggestion {
  offerId: string;
  name: string;
  cost: number;
  currentPrice: number;
  suggestedPrice: number;
  competitorAvg: number;
  exchangeRate: number;
  marginPercent: number;
  changePercent: number;
  needsExtraConfirm: boolean; // 利润率 <10%
  reason: string;
}

export interface PricingResult {
  applied: number;
  skipped: number;
  suggestions: PricingSuggestion[];
}

// ---- 配置 ----

const DEFAULT_MARGIN = 0.30; // 30% default margin
const MIN_MARGIN = parseFloat(process.env.PROMO_MIN_PROFIT_RATE || "0.10"); // from env
const MAX_CHANGE_PERCENT = 20; // ±20% per change
const MAX_ADJUSTMENTS_PER_DAY = 3;
const PRICING_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---- 状态 ----

let pricingTimer: ReturnType<typeof setInterval> | null = null;
let autoPricingEnabled = process.env.PROMO_AUTO_PRICING === "true";

/** 待确认的调价建议: key = `${chatId}:${offerId}` */
const pendingConfirmations = new Map<string, PricingSuggestion>();

/** 每日调价计数: key = `${date}:${offerId}` */
const dailyAdjustCount = new Map<string, number>();

export function isAutoPricingEnabled(): boolean {
  return autoPricingEnabled;
}

export function setAutoPricingEnabled(enabled: boolean): void {
  autoPricingEnabled = enabled;
  logger.info({ enabled }, "Auto pricing toggled");
}

export function getPendingCount(): number {
  return pendingConfirmations.size;
}

// ---- 生命周期 ----

export function startSmartPricing(bot: FeishuBot, chatId: string, config: ApiConfig): void {
  if (pricingTimer) return;

  logger.info({ intervalMs: PRICING_INTERVAL_MS }, "Smart pricing started");

  // 启动时立即执行一次
  runPricingCycle(bot, chatId, config).catch((err) => {
    logger.error({ err }, "Initial pricing cycle failed");
  });

  pricingTimer = setInterval(() => {
    runPricingCycle(bot, chatId, config).catch((err) => {
      logger.error({ err }, "Pricing cycle failed");
    });
  }, PRICING_INTERVAL_MS);
}

export function stopSmartPricing(): void {
  if (pricingTimer) {
    clearInterval(pricingTimer);
    pricingTimer = null;
  }
  pendingConfirmations.clear();
  logger.info("Smart pricing stopped");
}

// ---- 核心逻辑 ----

async function runPricingCycle(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
): Promise<void> {
  if (!autoPricingEnabled) {
    logger.info("Pricing cycle skipped — auto pricing disabled");
    return;
  }

  // 1. 获取汇率
  let rate = 12; // fallback
  try {
    const fx = await promoApi.exchangeRate(config);
    rate = Number((fx as Record<string, unknown>)?.rate || 12);
  } catch (err) {
    logger.warn({ err }, "Failed to fetch exchange rate, using fallback");
  }

  // 2. 获取在售商品（含成本）
  let items: Array<Record<string, unknown>> = [];
  try {
    const products = await promoApi.products(config);
    items = (products as { items?: Array<Record<string, unknown>> })?.items || [];
  } catch (err) {
    logger.error({ err }, "Failed to fetch products");
    return;
  }

  if (items.length === 0) return;

  // 3. 过滤：库存>0, 有成本数据
  const eligible = items.filter((item) => {
    const stock = Number(item.stock ?? item.quantity ?? 0);
    const cost = Number(item.cost ?? 0);
    return stock > 0 && cost > 0;
  });

  if (eligible.length === 0) {
    logger.info("No eligible products for pricing");
    return;
  }

  logger.info({ eligible: eligible.length, rate }, "Running pricing analysis");

  const suggestions: PricingSuggestion[] = [];

  for (const item of eligible) {
    const offerId = String(item.offerId || item.offer_id || "");
    const name = String(item.name || item.title || offerId).slice(0, 50);
    const cost = Number(item.cost || 0);
    const currentPrice = Number(item.price || 0);

    // 4. 获取竞品均价
    let competitorAvg = 0;
    try {
      const priceData = await competitorApi.getPrices(config, offerId, 3);
      const prices = priceData.prices || [];
      if (prices.length > 0) {
        competitorAvg = prices.reduce((s, p) => s + p.price, 0) / prices.length;
      }
    } catch {
      // 无竞品数据，仅基于成本计算
    }

    // 5. 计算建议价: max(cost × rate × (1+margin), competitorAvg × 0.95)
    const costBased = cost * rate * (1 + DEFAULT_MARGIN);
    const competitorBased = competitorAvg > 0 ? competitorAvg * 0.95 : 0;
    let suggested = Math.max(costBased, competitorBased);
    suggested = Math.round(suggested);

    if (suggested <= 0) continue;

    // 6. 安全检查：调价幅度不超过 ±20%
    const diffPct = currentPrice > 0
      ? Math.abs((suggested - currentPrice) / currentPrice)
      : 1;

    if (diffPct * 100 < 5) continue; // 差异<5% 忽略

    if (diffPct > MAX_CHANGE_PERCENT / 100) {
      logger.warn(
        { offerId, currentPrice, suggested, diffPct: (diffPct * 100).toFixed(1) },
        "Price change exceeds 20% limit, requires manual review",
      );
      continue; // 超过 20% 硬阻断，不纳入自动建议
    }

    // 7. 每日调价次数检查
    const today = new Date().toISOString().slice(0, 10);
    const adjustKey = `${today}:${offerId}`;
    const todayCount = dailyAdjustCount.get(adjustKey) || 0;
    if (todayCount >= MAX_ADJUSTMENTS_PER_DAY) {
      logger.info({ offerId }, "Max daily adjustments reached, skipping");
      continue;
    }

    // 8. 利润率检查
    const newMargin = ((suggested - cost * rate) / suggested) * 100;
    const needsExtraConfirm = newMargin < MIN_MARGIN * 100;

    // 9. Reason text
    let reason = "";
    if (costBased > competitorBased) {
      reason = `成本定价: ${cost.toFixed(0)} CNY × ${rate.toFixed(1)} × 1.30`;
    } else {
      reason = `竞品定价: 竞品均价 ${competitorAvg.toFixed(0)} ₽ × 0.95`;
    }

    suggestions.push({
      offerId,
      name,
      cost,
      currentPrice,
      suggestedPrice: suggested,
      competitorAvg,
      exchangeRate: rate,
      marginPercent: Math.round(newMargin * 10) / 10,
      changePercent: Math.round(diffPct * 1000) / 10,
      needsExtraConfirm,
      reason,
    });
  }

  if (suggestions.length === 0) {
    logger.info("No pricing suggestions generated");
    return;
  }

  // RAG 知识库增强：为每个建议附加历史经验
  for (const s of suggestions) {
    // 查询运营经验手册
    try {
      const ragResp = await fetch(`${config.apiBase}/api/rag/playbook/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
        body: JSON.stringify({ query: `定价策略 ${s.name}`, scenario: "pricing", topK: 3 }),
        signal: AbortSignal.timeout(5_000),
      });
      if (ragResp.ok) {
        const ragData = await ragResp.json() as { results?: Array<{ content: string; score: number }> };
        if (ragData.results?.length && ragData.results[0].score >= 0.7) {
          s.reason += ` | 定价参考: ${ragData.results[0].content.slice(0, 100)}`;
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, offerId: s.offerId }, "RAG playbook query degraded for pricing");
    }

    // 查询竞品分析报告
    try {
      const compResp = await fetch(`${config.apiBase}/api/rag/competitor/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
        body: JSON.stringify({ query: `${s.offerId} 价格趋势`, topK: 3 }),
        signal: AbortSignal.timeout(5_000),
      });
      if (compResp.ok) {
        const compData = await compResp.json() as { results?: Array<{ price_trend_summary?: string }> };
        if (compData.results?.length && compData.results[0].price_trend_summary) {
          s.reason += ` | 竞品趋势: ${compData.results[0].price_trend_summary}`;
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, offerId: s.offerId }, "RAG competitor query degraded for pricing");
    }
  }

  // 按变动幅度排序
  suggestions.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

  // 9. 发送调价建议到飞书
  await sendPricingSuggestions(bot, chatId, suggestions);
}

/** 发送调价建议卡片 */
async function sendPricingSuggestions(
  bot: FeishuBot,
  chatId: string,
  suggestions: PricingSuggestion[],
): Promise<void> {
  const lines: string[] = [
    `💡 **智能调价建议** (${suggestions.length} 项)`,
    `💱 汇率: 1 CNY = ${suggestions[0]?.exchangeRate.toFixed(1) || "?"} RUB`,
    "",
  ];

  for (const s of suggestions.slice(0, 10)) {
    const emoji = s.changePercent > 0 ? "📈" : "📉";
    const warn = s.needsExtraConfirm ? " ⚠️低利润" : "";
    const dir = s.changePercent > 0 ? "+" : "";

    lines.push(
      `${emoji} **${s.name}**${warn}`,
      `   当前: ${s.currentPrice.toFixed(0)} ₽ → 建议: ${s.suggestedPrice.toFixed(0)} ₽ (${dir}${s.changePercent}%)`,
      `   ${s.reason} | 利润率: ${s.marginPercent}%`,
    );

    // 存入待确认列表
    const key = `${chatId}:${s.offerId}`;
    pendingConfirmations.set(key, s);
  }

  if (suggestions.length > 10) {
    lines.push(`... 还有 ${suggestions.length - 10} 项`);
  }

  lines.push(
    "",
    "⚠️ 合规提示：调价幅度不超过 20%，每日每商品最多 3 次调价",
    `回复 "yes" 自动调价，或发送 "推广暂停" 暂停自动调价`,
  );

  try {
    await bot.sendMessage(chatId, lines.join("\n"));
    logger.info({ count: suggestions.length }, "Pricing suggestions sent");
  } catch (err) {
    logger.error({ err }, "Failed to send pricing suggestions");
  }
}

// ---- 确认处理 ----

export interface ConfirmResult {
  applied: string[];
  skipped: string[];
  errors: string[];
}

/**
 * 处理用户确认调价
 * 支持: "yes" (全部确认), "yes <offerId>" (单项确认)
 */
export async function handlePricingConfirmation(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
  targetOfferId?: string,
): Promise<ConfirmResult> {
  const result: ConfirmResult = { applied: [], skipped: [], errors: [] };

  // 找到该 chatId 的所有待确认项
  const pending: { key: string; suggestion: PricingSuggestion }[] = [];
  for (const [key, s] of pendingConfirmations) {
    if (key.startsWith(`${chatId}:`)) {
      if (!targetOfferId || key === `${chatId}:${targetOfferId}`) {
        pending.push({ key, suggestion: s });
      }
    }
  }

  if (pending.length === 0) {
    result.skipped.push("无待确认的调价建议。");
    return result;
  }

  for (const { key, suggestion: s } of pending) {
    pendingConfirmations.delete(key);

    try {
      // 最终安全检查
      const skipReason = validateBeforeApply(s);
      if (skipReason) {
        result.skipped.push(`${s.name}: ${skipReason}`);
        continue;
      }

      // 调用 Ozon API 更新价格
      await promoApi.updatePrice(config, s.offerId, s.suggestedPrice);

      // 记录每日调价计数
      const today = new Date().toISOString().slice(0, 10);
      const adjustKey = `${today}:${s.offerId}`;
      dailyAdjustCount.set(adjustKey, (dailyAdjustCount.get(adjustKey) || 0) + 1);

      result.applied.push(`${s.name}: ${s.currentPrice.toFixed(0)} → ${s.suggestedPrice.toFixed(0)} ₽`);
      logger.info({ offerId: s.offerId, from: s.currentPrice, to: s.suggestedPrice }, "Price updated");

      // RAG 写回：异步记录定价执行经验
      fetch(`${config.apiBase}/api/rag/playbook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
        body: JSON.stringify({
          title: `定价执行: ${s.offerId}`,
          scenario: "pricing",
          content: `原价${s.currentPrice}→新价${s.suggestedPrice}, 原因: ${s.reason}`,
          tags: ["定价", "执行"],
          author: "smart-pricing",
        }),
        signal: AbortSignal.timeout(3_000),
      }).catch(() => {}); // fire-and-forget
    } catch (err) {
      result.errors.push(`${s.name}: ${(err as Error).message}`);
      logger.error({ err, offerId: s.offerId }, "Price update failed");
    }

    // 避免 API 限流
    await sleep(500);
  }

  // 发送结果
  const resultLines: string[] = ["📋 **调价结果**", ""];
  if (result.applied.length > 0) {
    resultLines.push(`✅ 已应用 (${result.applied.length}):`, ...result.applied.map((s) => `   ${s}`), "");
  }
  if (result.skipped.length > 0) {
    resultLines.push(`⏭ 已跳过 (${result.skipped.length}):`, ...result.skipped.map((s) => `   ${s}`), "");
  }
  if (result.errors.length > 0) {
    resultLines.push(`❌ 失败 (${result.errors.length}):`, ...result.errors.map((s) => `   ${s}`), "");
  }

  try {
    await bot.sendMessage(chatId, resultLines.join("\n"));
  } catch {
    await bot.sendMessage(chatId, resultLines.join("\n"));
  }

  return result;
}

/** 执行前最终验证 */
function validateBeforeApply(s: PricingSuggestion): string | null {
  // 安全上限：变化不超过 ±20%（二次确认）
  if (Math.abs(s.changePercent) > MAX_CHANGE_PERCENT) {
    return `变动幅度 ${s.changePercent}% 超过 ±20% 限制`;
  }

  // 利润率低于 10% 必须人工确认（needsExtraConfirm 已标记，但仍允许）
  // 这里只做硬性阻断

  // 价格不能为 0 或负数
  if (s.suggestedPrice <= 0) {
    return "建议价格无效";
  }

  // 当日调价次数（再次检查）
  const today = new Date().toISOString().slice(0, 10);
  const adjustKey = `${today}:${s.offerId}`;
  const todayCount = dailyAdjustCount.get(adjustKey) || 0;
  if (todayCount >= MAX_ADJUSTMENTS_PER_DAY) {
    return `今日已调价 ${todayCount} 次，已达上限`;
  }

  return null;
}

// ---- 导出给 commands.ts 使用 ----

/** 获取待确认的建议列表（用于展示） */
export function getPendingSuggestions(chatId: string): PricingSuggestion[] {
  const result: PricingSuggestion[] = [];
  for (const [key, s] of pendingConfirmations) {
    if (key.startsWith(`${chatId}:`)) {
      result.push(s);
    }
  }
  return result;
}

// ---- 工具 ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
