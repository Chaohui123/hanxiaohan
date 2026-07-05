import type { FeishuBot } from "@onzo/feishu-bot";
import type { ApiConfig } from "./api-client.js";
import { promoApi, competitorApi } from "./api-client.js";
import { logger } from "@onzo/logger";
import { competitorCheckCounter } from "./metrics.js";

// ---- 类型 ----

export interface WatchEntry {
  offerId: string;
  name: string;
}

export interface CompetitorSnapshot {
  offerId: string;
  name: string;
  price: number;
  rating: number;
  salesCount: number;
}

export interface CompetitorAlert {
  offerId: string;
  name: string;
  myPrice: number;
  competitorAvg: number;
  dropPercent: number;
}

export interface CompetitorWatchConfig {
  chatId: string;
  apiConfig: ApiConfig;
}

// ---- 状态 ----

let watchTimer: ReturnType<typeof setInterval> | null = null;
let scraperCheckTimer: ReturnType<typeof setInterval> | null = null;
let scraperBlocked = false;
let blockedNotified = false;

const WATCH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const SCRAPER_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// ---- 生命周期 ----

export function startCompetitorWatch(bot: FeishuBot, config: CompetitorWatchConfig): void {
  if (watchTimer) return;

  logger.info({ intervalMs: WATCH_INTERVAL_MS }, "Competitor watch started");

  // 启动时立即执行一次
  runCompetitorCheck(bot, config).catch((err) => {
    logger.error({ err }, "Initial competitor check failed");
  });

  watchTimer = setInterval(() => {
    runCompetitorCheck(bot, config).catch((err) => {
      logger.error({ err }, "Competitor check failed");
    });
  }, WATCH_INTERVAL_MS);

  // 爬虫状态检测
  scraperCheckTimer = setInterval(() => {
    checkScraperStatus(bot, config).catch((err) => {
      logger.error({ err }, "Scraper status check failed");
    });
  }, SCRAPER_CHECK_INTERVAL_MS);
}

export function stopCompetitorWatch(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  if (scraperCheckTimer) {
    clearInterval(scraperCheckTimer);
    scraperCheckTimer = null;
  }
  logger.info("Competitor watch stopped");
}

export function isScraperBlocked(): boolean {
  return scraperBlocked;
}

// ---- 核心逻辑 ----

async function runCompetitorCheck(bot: FeishuBot, config: CompetitorWatchConfig): Promise<void> {
  const { apiConfig, chatId } = config;

  if (scraperBlocked) {
    logger.warn("Competitor watch skipped — scraper blocked");
    return;
  }

  // 1. 读取监控列表
  let watchList: WatchEntry[] = [];
  try {
    const data = await competitorApi.getWatchList(apiConfig);
    watchList = data.items || [];
  } catch (err) {
    logger.error({ err }, "Failed to fetch watch list");
    return;
  }

  if (watchList.length === 0) {
    logger.info("Watch list empty, skipping competitor check");
    return;
  }

  // 2. 获取我的商品价格，构建 offerId → price 映射
  const myPriceMap = new Map<string, number>();
  try {
    const products = await promoApi.products(config.apiConfig);
    const items = (products as { items?: Array<Record<string, unknown>> })?.items || [];
    for (const item of items) {
      const oid = String(item.offerId || item.offer_id || "");
      const price = Number(item.price || 0);
      if (oid && price > 0) myPriceMap.set(oid, price);
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch product prices for competitor check");
  }

  logger.info({ count: watchList.length }, "Running competitor check");

  // 3. 对每个商品搜索竞品
  const alerts: CompetitorAlert[] = [];

  for (const entry of watchList) {
    try {
      const snapshot = await searchAndSave(apiConfig, entry);

      // 4. 检查是否降价超过 10%
      if (snapshot) {
        const alert = await checkPriceDrop(apiConfig, entry, snapshot, myPriceMap);
        if (alert) alerts.push(alert);
      }
    } catch (err) {
      logger.error({ err, offerId: entry.offerId }, "Competitor search failed for item");
      // 判断是否为爬虫被封
      if ((err as Error).message?.includes("429") || (err as Error).message?.includes("blocked")) {
        await handleScraperBlocked(bot, config);
      }
    }

    // 避免请求太密集
    await sleep(2000);
  }

  // 5. 发送汇总通知
  if (alerts.length > 0) {
    await sendAlerts(bot, chatId, alerts, apiConfig);
  }

  competitorCheckCounter.inc({ result: scraperBlocked ? "blocked" : "success" });
  logger.info({ checked: watchList.length, alerts: alerts.length }, "Competitor check complete");
}

/** 搜索竞品并存储价格快照 */
async function searchAndSave(
  apiConfig: ApiConfig,
  entry: WatchEntry,
): Promise<CompetitorSnapshot | null> {
  // 搜索同名/相似商品
  const searchResult = await competitorApi.searchCompetitors(apiConfig, entry.name);
  const items = searchResult.items || [];

  if (items.length === 0) {
    logger.info({ offerId: entry.offerId }, "No competitors found");
    return null;
  }

  // 提取竞品数据
  const prices = items.map((item) => ({
    price: item.price,
    rating: item.rating,
    salesCount: item.salesCount,
    capturedAt: new Date().toISOString(),
  }));

  // 存储价格快照
  await competitorApi.savePrices(apiConfig, entry.offerId, prices).catch((err) => {
    logger.error({ err, offerId: entry.offerId }, "Failed to save competitor prices");
  });

  // 计算竞品均价
  const avgPrice = items.reduce((sum, item) => sum + item.price, 0) / items.length;

  return {
    offerId: entry.offerId,
    name: entry.name,
    price: avgPrice,
    rating: items.reduce((sum, item) => sum + item.rating, 0) / items.length,
    salesCount: items.reduce((sum, item) => sum + item.salesCount, 0),
  };
}

/** 检查竞品是否降价超过阈值 */
async function checkPriceDrop(
  apiConfig: ApiConfig,
  entry: WatchEntry,
  current: CompetitorSnapshot,
  myPriceMap: Map<string, number>,
): Promise<CompetitorAlert | null> {
  // 获取上一次价格记录
  let prevAvg = 0;
  try {
    const data = await competitorApi.getPrices(apiConfig, entry.offerId, 14);
    const prices = data.prices || [];
    if (prices.length >= 2) {
      // 取倒数第二次的价格平均值
      const prevPrices = prices.slice(-12, -6); // 上一个检查周期的价格
      if (prevPrices.length > 0) {
        prevAvg = prevPrices.reduce((s, p) => s + p.price, 0) / prevPrices.length;
      }
    }
  } catch {
    // 首次检查，无历史数据
    return null;
  }

  if (prevAvg <= 0) return null;

  const dropPercent = ((prevAvg - current.price) / prevAvg) * 100;

  if (dropPercent >= 10) {
    const myPrice = myPriceMap.get(entry.offerId) || 0;
    return {
      offerId: entry.offerId,
      name: entry.name,
      myPrice,
      competitorAvg: current.price,
      dropPercent: Math.round(dropPercent * 10) / 10,
    };
  }

  return null;
}

/** 发送降价通知（含 RAG 历史分析） */
async function sendAlerts(
  bot: FeishuBot,
  chatId: string,
  alerts: CompetitorAlert[],
  apiConfig: ApiConfig,
): Promise<void> {
  const lines: string[] = [];
  for (const a of alerts) {
    const emoji = a.dropPercent >= 20 ? "🔴" : "🟡";
    const myPriceStr = a.myPrice > 0 ? `${a.myPrice.toFixed(0)}₽` : "—";
    lines.push(`${emoji} ${a.name} | 我的: ${myPriceStr} | 竞品均: ${a.competitorAvg.toFixed(0)}₽ | 降幅: ${a.dropPercent}%`);

    // RAG history enrichment
    const ragCtx = await enrichAlertWithRag(a, apiConfig);
    if (ragCtx) lines.push(`   ${ragCtx}`);
  }

  const message = [
    `🚨 竞品降价警报 (${alerts.length} 项)`,
    "",
    ...lines,
    "",
    "建议: 检查定价策略，考虑调整价格或加强推广",
  ].join("\n");

  try {
    await bot.sendMessage(chatId, message);
  } catch (err) {
    logger.error({ err }, "Failed to send alert");
  }
}

async function enrichAlertWithRag(alert: CompetitorAlert, config: ApiConfig): Promise<string> {
  try {
    const resp = await fetch(`${config.apiBase}/api/rag/competitor/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify({ query: `${alert.name} 价格趋势分析`, offerId: alert.offerId, topK: 2 }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!resp.ok) return "";
    const data = await resp.json() as { results?: Array<{ score: number; priceTrendSummary?: string; reportText?: string }> };
    if (data.results?.length) {
      return data.results
        .map((r) => `📊 历史分析(相似度${(r.score || 0).toFixed(2)}): ${r.priceTrendSummary || (r.reportText || "").slice(0, 100)}`)
        .join("\n");
    }
  } catch { /* RAG unavailable, skip enrichment */ }
  return "";
}

// ---- 爬虫联动 ----

/** 检测爬虫状态，与 ops-agent 联动 */
async function checkScraperStatus(bot: FeishuBot, config: CompetitorWatchConfig): Promise<void> {
  try {
    const data = await competitorApi.getScraperStatus(config.apiConfig);
    const wasBlocked = scraperBlocked;
    scraperBlocked = data.status === "blocked";

    if (scraperBlocked && !wasBlocked) {
      await handleScraperBlocked(bot, config);
    } else if (!scraperBlocked && wasBlocked) {
      // 爬虫恢复
      scraperBlocked = false;
      blockedNotified = false;
      logger.info("Scraper recovered, resuming competitor watch");
      await bot.sendMessage(
        config.chatId,
        "✅ 爬虫已恢复，竞品监控自动重启。",
      ).catch(() => {});
    }
  } catch (err) {
    // 检查失败静默处理，下次再试
    logger.warn({ err }, "Scraper status check failed");
  }
}

/** 爬虫被封处理：写入事件 + 通知 */
async function handleScraperBlocked(bot: FeishuBot, config: CompetitorWatchConfig): Promise<void> {
  scraperBlocked = true;

  // 写入 PROMO_SCRAPER_BLOCKED 事件
  try {
    await competitorApi.postEvent(config.apiConfig, {
      type: "PROMO_SCRAPER_BLOCKED",
      payload: {
        detectedAt: new Date().toISOString(),
        source: "competitor-watch",
      },
    });
    logger.info("PROMO_SCRAPER_BLOCKED event posted");
  } catch (err) {
    logger.error({ err }, "Failed to post scraper blocked event");
  }

  // 通知用户（仅通知一次）
  if (!blockedNotified) {
    blockedNotified = true;
    try {
      await bot.sendMessage(
        config.chatId,
        "⚠️ **爬虫已被封禁**\n\n" +
          "竞品监控已暂停。\n" +
          "ops-agent 将自动重试，恢复后自动重启监控。\n" +
          "无需手动干预。",
      );
    } catch (err) {
      logger.error({ err }, "Failed to send blocked notification");
    }
  }
}

// ---- 工具 ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
