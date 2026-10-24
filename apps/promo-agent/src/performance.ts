import type { FeishuBot } from "@onzo/feishu-bot";
import type { ApiConfig } from "./api-client.js";
import { statsApi, promoApi } from "./api-client.js";
import { logger } from "@onzo/logger";
import { queryRag, extractRagContent } from "@onzo/embedding";

// ---- 类型 ----

export interface DailyReport {
  date: string;
  orders: number;
  revenue: number;
  avgOrderValue: number;
  cancelledOrders: number;
  topProducts: Array<{ offerId: string; name: string; orders: number; revenue: number }>;
  competitorChanges: number;
  pricingAdjustments: number;
  copyOptimizations: number;
  roi: number | null;
  adSpend: number | null; // null = 广告 API 未接入/无数据
}

export interface WeeklyReport {
  from: string;
  to: string;
  orders: number;
  revenue: number;
  byDay: Array<{ date: string; orders: number; revenue: number }>;
  top5: Array<{ offerId: string; name: string; orders: number; revenue: number }>;
  bottom5: Array<{ offerId: string; name: string; orders: number; stock: number }>;
  competitorTrend: string; // summary text
  roi: number | null;
  suggestions: string[];
}

// ---- 配置 ----

const REPORT_CHECK_INTERVAL_MS = 60_000; // every minute
const DAILY_HOUR = 9;
const WEEKLY_DAY = 1; // Monday

// ---- 状态 ----

let reportTimer: ReturnType<typeof setInterval> | null = null;
let reportCheckRunning = false;
let lastDailySent = ""; // date string YYYY-MM-DD
let lastWeeklySent = ""; // monday date string
let lastRetroDate = ""; // last retrospective date

// ---- 生命周期 ----

export function startPerformanceReports(bot: FeishuBot, chatId: string, config: ApiConfig): void {
  if (reportTimer) return;

  logger.info("Performance reports scheduler started");

  reportTimer = setInterval(() => {
    if (reportCheckRunning) return;
    reportCheckRunning = true;
    checkAndSend(bot, chatId, config).catch((err) => {
      logger.error({ err }, "Performance report check failed");
    }).finally(() => {
      reportCheckRunning = false;
    });
  }, REPORT_CHECK_INTERVAL_MS);
}

export function stopPerformanceReports(): void {
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
  logger.info("Performance reports scheduler stopped");
}

// ---- 调度检查 ----

export async function checkAndSend(bot: FeishuBot, chatId: string, config: ApiConfig): Promise<void> {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon

  // 09:00 起发送；失败后下一分钟重试，成功后才防重。
  if (hour === DAILY_HOUR) {
    const today = now.toISOString().slice(0, 10);
    if (lastDailySent !== today && await sendDailyReport(bot, chatId, config)) {
      lastDailySent = today;
    }
  }

  // 每日 03:00 效果回溯
  if (hour === 3 && minute === 0) {
    const today = now.toISOString().slice(0, 10);
    if (lastRetroDate !== today) {
      lastRetroDate = today;
      await runEffectRetrospective(config).catch((err) => logger.error({ err }, "Effect retrospective failed"));
    }
  }

  // 周一 09:01 起发送；失败后下一分钟重试，成功后才防重。
  if (dayOfWeek === WEEKLY_DAY && hour === DAILY_HOUR && minute >= 1) {
    const monday = getMonday(now);
    if (lastWeeklySent !== monday && await sendWeeklyReport(bot, chatId, config)) {
      lastWeeklySent = monday;
    }
  }
}

type SourceResult<T> = { data: T | null; failed: boolean };

async function loadSource<T>(name: string, request: Promise<T>): Promise<SourceResult<T>> {
  try {
    const data = await request;
    if (data == null) throw new Error("empty API response");
    return { data, failed: false };
  } catch (err) {
    logger.warn({ err, source: name }, "Report data source failed");
    return { data: null, failed: true };
  }
}

// ---- 日报 ----

export async function sendDailyReport(bot: FeishuBot, chatId: string, config: ApiConfig): Promise<boolean> {
  const yesterday = daysAgo(1);
  const yesterday2 = daysAgo(2);

  logger.info({ date: yesterday }, "Generating daily report");

  try {
    const [dailyResult, prevResult, pricingResult, copyResult, costResult] = await Promise.all([
      loadSource("daily", statsApi.daily(config, yesterday)),
      loadSource("previousDaily", statsApi.daily(config, yesterday2)),
      loadSource("pricing", statsApi.pricingHistory(config, 1)),
      loadSource("copy", statsApi.copyHistory(config, 1)),
      loadSource("ads", statsApi.promoCost(config, yesterday, yesterday)),
    ]);
    const dailyData = dailyResult.data;
    const prevDaily = prevResult.data;
    const pricingData = pricingResult.data;
    const copyData = copyResult.data;
    const costData = costResult.data;

    const orders = dailyData?.orders ?? null;
    const revenue = dailyData?.revenue ?? null;
    const prevOrders = prevDaily?.orders ?? null;
    const prevRevenue = prevDaily?.revenue ?? null;

    const orderDiff = orders === null || prevOrders === null ? null : prevOrders > 0
      ? ((orders - prevOrders) / prevOrders * 100)
      : 0;
    const revenueDiff = revenue === null || prevRevenue === null ? null : prevRevenue > 0
      ? ((revenue - prevRevenue) / prevRevenue * 100)
      : 0;

    const avgOrderValue = orders === null || revenue === null ? null : orders > 0 ? revenue / orders : 0;
    const cancelledOrders = dailyData?.cancelledOrders ?? null;
    const pricingAdjustments = pricingResult.failed ? null : Array.isArray(pricingData?.adjustments) ? pricingData.adjustments.length : 0;
    const copyOptimizations = copyResult.failed ? null : Array.isArray(copyData?.copies) ? copyData.copies.length : 0;
    const adSpend = costData?.adSpend ?? null;
    const roi = costData?.roi ?? null;

    const lines = [
      `📊 **日报 ${yesterday}**`,
      "",
      `📦 订单: ${orders === null ? "**未知/同步失败**" : `**${orders}** 笔 ${formatDiff(orderDiff)}`}`,
      `💰 销售额: ${revenue === null ? "**未知/同步失败**" : `${fmtRub(revenue)} ${formatDiff(revenueDiff)}`}`,
      `🧾 客单价: ${fmtRub(avgOrderValue)}`,
      cancelledOrders === null ? "🚫 取消: 未知/同步失败" : cancelledOrders > 0 ? `🚫 取消: ${cancelledOrders} 笔` : "",
      "",
      `📈 推广效果`,
      costResult.failed ? "🔥 广告花费: 未知/同步失败" : adSpend !== null ? `🔥 广告花费: ${fmtRub(adSpend)}` : `🔥 广告花费: 未接入/无数据`,
      costResult.failed ? "💎 ROI: 未知/同步失败" : roi !== null ? `💎 ROI: **${roi.toFixed(2)}x**` : `💎 ROI: 暂无数据`,
      `🔧 调价: ${pricingAdjustments ?? "未知/同步失败"}${pricingAdjustments === null ? "" : " 次"}`,
      `✍️ 文案优化: ${copyOptimizations ?? "未知/同步失败"}${copyOptimizations === null ? "" : " 次"}`,
      "",
    ];

    const tops = Array.isArray(dailyData?.topProducts) ? dailyData.topProducts : [];
    if (tops.length > 0) {
      lines.push(`🏆 **Top 商品**`);
      tops.slice(0, 3).forEach((p, i) => {
        lines.push(`   ${i + 1}. ${p.name?.slice(0, 30) || p.offerId}: ${p.orders}笔 ${fmtRub(p.revenue)}`);
      });
      lines.push("");
    }

    lines.push(`💡 /promo — 查看推广总览 | /promo sales — 销售趋势`);

    const sent = await bot.sendMessage(chatId, lines.join("\n"));
    if (!sent) {
      logger.error({ date: yesterday }, "Daily report was not sent");
      return false;
    }
    logger.info("Daily report sent");
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to send daily report");
    await bot.sendMessage(chatId, `⚠️ 日报生成失败: ${(err as Error).message}`).catch(() => {});
    return false;
  }
}

// ---- 周报 ----

export async function sendWeeklyReport(bot: FeishuBot, chatId: string, config: ApiConfig): Promise<boolean> {
  const from = daysAgo(7);
  const to = daysAgo(1);

  logger.info({ from, to }, "Generating weekly report");

  try {
    const [weeklyResult, costResult, pricingResult, copyResult] = await Promise.all([
      loadSource("weekly", statsApi.weekly(config, from, to)),
      loadSource("ads", statsApi.promoCost(config, from, to)),
      loadSource("pricing", statsApi.pricingHistory(config, 7)),
      loadSource("copy", statsApi.copyHistory(config, 7)),
    ]);
    const weeklyData = weeklyResult.data;
    const costData = costResult.data;
    const pricingData = pricingResult.data;
    const copyData = copyResult.data;

    const orders = weeklyData?.orders ?? null;
    const revenue = weeklyData?.revenue ?? null;
    const adSpend = costData?.adSpend ?? null;
    const roi = costData?.roi ?? null;
    const organicRatio = !costResult.failed && costData?.organicRevenue != null && costData?.totalRevenue
      ? (costData.organicRevenue / costData.totalRevenue * 100)
      : null;

    const pricingActions = Array.isArray(pricingData?.adjustments) ? pricingData.adjustments : [];
    const copyActions = Array.isArray(copyData?.copies) ? copyData.copies : [];
    const pricingAdjustments = pricingResult.failed ? null : pricingActions.length;
    const copyOptimizations = copyResult.failed ? null : copyActions.length;
    const pricingSalesAfter = pricingResult.failed ? null : pricingActions.reduce((sum, a) => sum + (a.salesAfter || 0), 0);

    const lines = [
      `📈 **周报 ${from} ~ ${to}**`,
      "",
      `📦 总订单: ${orders === null ? "**未知/同步失败**" : `**${orders}** 笔`}`,
      `💰 总销售额: ${revenue === null ? "**未知/同步失败**" : `**${fmtRub(revenue)}**`}`,
      `🧾 日均: ${orders === null || revenue === null ? "未知/同步失败" : `${(orders / 7).toFixed(0)} 笔 / ${fmtRub(revenue / 7)}`}`,
      "",
      `📊 **推广效果**`,
      costResult.failed ? "🔥 广告花费: 未知/同步失败" : adSpend !== null ? `🔥 广告花费: ${fmtRub(adSpend)}` : `🔥 广告花费: 未接入/无数据`,
      costResult.failed ? "💎 ROI: 未知/同步失败" : roi !== null ? `💎 ROI: **${roi.toFixed(2)}x**` : `💎 ROI: 暂无数据`,
      costResult.failed ? "🌿 自然流占比: 未知/同步失败" : organicRatio !== null ? `🌿 自然流占比: **${organicRatio.toFixed(0)}%**` : "",
      `🔧 调价次数: ${pricingAdjustments ?? "未知/同步失败"}`,
      `✍️ 文案优化: ${copyOptimizations ?? "未知/同步失败"}`,
      pricingSalesAfter === null ? "📈 调价后增量: 未知/同步失败" : pricingSalesAfter > 0 ? `📈 调价后增量: ${pricingSalesAfter} 笔` : "",
      "",
    ];

    const byDay = Array.isArray(weeklyData?.byDay) ? weeklyData.byDay : [];
    if (byDay.length > 0) {
      lines.push(`📉 **7 天趋势**`);
      const maxOrders = Math.max(...byDay.map((d) => d.orders), 1);
      for (const day of byDay) {
        const barLen = Math.max(1, Math.round((day.orders / maxOrders) * 15));
        const bar = "█".repeat(barLen);
        lines.push(`${day.date.slice(5)} ${bar} ${day.orders}笔 ${fmtRub(day.revenue)}`);
      }
      lines.push("");
    }

    const top5 = Array.isArray(weeklyData?.top5) ? weeklyData.top5 : [];
    if (top5.length > 0) {
      lines.push(`🏆 **Top 5 热销**`);
      top5.forEach((p, i) => {
        lines.push(`   ${i + 1}. ${p.name?.slice(0, 25) || p.offerId}: ${p.orders}笔 ${fmtRub(p.revenue)}`);
      });
      lines.push("");
    }

    const bottom5 = Array.isArray(weeklyData?.bottom5) ? weeklyData.bottom5 : [];
    if (bottom5.length > 0) {
      lines.push(`🐌 **滞销 Top 5**`);
      bottom5.forEach((p, i) => {
        lines.push(`   ${i + 1}. ${p.name?.slice(0, 25) || p.offerId}: ${p.orders}笔 库存${p.stock || 0}`);
      });
      lines.push("");
    }

    const suggestions = await generateWeeklySuggestions({
      top5,
      bottom5,
      roi,
      organicRatio,
      orders,
      revenue,
      pricingAdjustments,
      copyOptimizations,
    }, config);

    const retrospectiveFailed = pricingResult.failed || copyResult.failed;
    const pricingImproved = pricingActions.filter((a: Record<string, unknown>) => Number(a.salesAfter || 0) > Number(a.salesBefore || 0)).length;
    const copyImproved = copyActions.filter((c: Record<string, unknown>) => Number(c.salesAfter || 0) > Number(c.salesBefore || 0)).length;
    const allActions: Record<string, unknown>[] = [...pricingActions, ...copyActions];
    const avgIncrement = retrospectiveFailed ? null : allActions.length > 0
      ? (allActions.reduce((sum, a) => sum + (Number(a.salesAfter || 0) - Number(a.salesBefore || 0)), 0) / allActions.length).toFixed(1)
      : "0";

    lines.push("");
    if (process.env.PROMO_AB_TEST === "true") {
      lines.push("🧪 **A/B 测试结果**");
      if (retrospectiveFailed) {
        lines.push("实验/对照数据: 未知/同步失败");
      } else {
        const expActions = allActions.filter((a) => String(a.reason || "").includes("pricing") || String(a.reason || "").includes("copy"));
        const ctrlActions = allActions.filter((a) => String(a.reason || "").includes("control"));
        const expGrowth = expActions.length > 0
          ? (expActions.reduce((sum, a) => sum + (Number(a.salesAfter || 0) - Number(a.salesBefore || 0)), 0) / expActions.length).toFixed(1)
          : "0";
        const ctrlGrowth = ctrlActions.length > 0
          ? (ctrlActions.reduce((sum, a) => sum + (Number(a.salesAfter || 0) - Number(a.salesBefore || 0)), 0) / ctrlActions.length).toFixed(1)
          : "0";
        const netEffect = (parseFloat(expGrowth) - parseFloat(ctrlGrowth)).toFixed(1);
        lines.push(`实验组(推广): 平均增量 +${expGrowth}%`);
        lines.push(`对照组(无推广): 平均增量 +${ctrlGrowth}%`);
        lines.push(`推广净效果: +${netEffect}%`);
      }
      lines.push("");
    }

    lines.push("📊 **推广效果回溯**");
    lines.push(pricingResult.failed ? "调价效果: 未知/同步失败" : `调价效果: ${pricingImproved}/${pricingActions.length} 商品销量提升`);
    lines.push(copyResult.failed ? "文案效果: 未知/同步失败" : `文案效果: ${copyImproved}/${copyActions.length} 商品销量提升`);
    lines.push(avgIncrement === null ? "平均增量: 未知/同步失败" : `平均增量: +${avgIncrement}%`);
    lines.push("");

    lines.push(`💡 **下周推广建议**`);
    suggestions.forEach((s, i) => {
      lines.push(`   ${i + 1}. ${s}`);
    });

    const sent = await bot.sendMessage(chatId, lines.join("\n"));
    if (!sent) {
      logger.error({ from, to }, "Weekly report was not sent");
      return false;
    }
    logger.info("Weekly report sent");
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to send weekly report");
    await bot.sendMessage(chatId, `⚠️ 周报生成失败: ${(err as Error).message}`).catch(() => {});
    return false;
  }
}

// ---- 效果回溯 ----

export function extractOrderList(payload: unknown): Array<Record<string, unknown>> | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as { orders?: unknown; data?: unknown };
  if (Array.isArray(body.orders)) return body.orders;
  if (Array.isArray(body.data)) return body.data;
  return null;
}

function orderItems(order: Record<string, unknown>): Array<Record<string, unknown>> | null {
  if (order.items != null) return Array.isArray(order.items) ? order.items : null;
  if (order.products != null) return Array.isArray(order.products) ? order.products : null;
  if (typeof order.products_json === "string") {
    try {
      const parsed: unknown = JSON.parse(order.products_json);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return [];
}

export async function runEffectRetrospective(config: ApiConfig): Promise<void> {
  try {
    const [pricingData, copyData] = await Promise.all([
      statsApi.pricingHistory(config, 7).catch(() => null),
      statsApi.copyHistory(config, 7).catch(() => null),
    ]);

    const pricingActions = Array.isArray(pricingData?.adjustments) ? pricingData.adjustments : [];
    const copyActions = Array.isArray(copyData?.copies) ? copyData.copies : [];
    let updated = 0;

    for (const action of [...pricingActions, ...copyActions]) {
      const a = action as Record<string, unknown>;
      if (Number(a.salesAfter || a.salesAfter7d || 0) > 0) continue; // already retrospected

      const appliedDate = new Date(String(a.appliedAt || ""));
      if (isNaN(appliedDate.getTime())) continue;

      const sevenDaysLater = new Date(appliedDate.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (new Date() < sevenDaysLater) continue; // not yet 7 days

      let recentOrders = 0;
      try {
        const orders = await promoApi.orders(config, 7);
        const orderList = extractOrderList(orders);
        if (!orderList) {
          logger.warn({ offerId: a.offerId }, "Orders API returned no valid orders/data array; retrospective skipped");
          continue;
        }
        for (const order of orderList) {
          if (!order || typeof order !== "object" || Array.isArray(order)) {
            logger.warn({ offerId: a.offerId }, "Malformed order row skipped during retrospective");
            continue;
          }
          const orderDate = new Date(String(order.createdAt || order.created_at || order.synced_at || ""));
          if (orderDate >= appliedDate && orderDate <= sevenDaysLater) {
            const items = orderItems(order);
            if (!items) {
              logger.warn({ offerId: a.offerId }, "Malformed order items skipped during retrospective");
              continue;
            }
            for (const item of items) {
              if (!item || typeof item !== "object" || Array.isArray(item)) {
                logger.warn({ offerId: a.offerId }, "Malformed order item skipped during retrospective");
                continue;
              }
              if (String(item.offerId || item.offer_id || "") === String(a.offerId)) {
                recentOrders++;
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ err, offerId: a.offerId }, "Orders API failed; retrospective skipped");
        continue;
      }

      if (recentOrders > 0) {
        try {
          await promoApi.updateProduct(config, String(a.offerId || ""), {
            salesAfter7d: recentOrders,
            effectRetrospectedAt: new Date().toISOString(),
          });
          updated++;
          logger.info({ offerId: a.offerId, salesAfter: recentOrders }, "Effect retrospected");
        } catch (err) {
          logger.warn({ err, offerId: a.offerId }, "Failed to update retrospective data");
        }
      }
    }

    // RAG 增强：查询文案模板库
    if (updated > 0) {
      const copyResults = await queryRag(config, "copy", "推广文案效果对比");
      if (copyResults.length) logger.info({ count: copyResults.length }, "RAG copy templates for retrospective");
    }

    if (updated > 0) logger.info({ updated }, "Effect retrospective complete");
  } catch (err) {
    logger.error({ err }, "Effect retrospective failed");
  }
}

// ---- 建议生成 ----

async function generateWeeklySuggestions(ctx: {
  top5: Array<{ name: string; orders: number }>;
  bottom5: Array<{ name: string; orders: number; stock: number }>;
  roi: number | null;
  organicRatio: number | null;
  orders: number | null;
  revenue: number | null;
  pricingAdjustments: number | null;
  copyOptimizations: number | null;
}, config: ApiConfig): Promise<string[]> {
  const suggestions: string[] = [];

  // 滞销品处理
  const deadStock = ctx.bottom5.filter((p) => p.stock > 0 && p.orders === 0);
  if (deadStock.length > 0) {
    suggestions.push(
      `滞销清理: ${deadStock.map((p) => p.name.slice(0, 15)).join(", ")} 等 ${deadStock.length} 件零动销，建议降价 15-20% 或捆绑促销`
    );
  }

  // 热销品补货
  if (ctx.top5.length > 0) {
    suggestions.push(
      `热销补货: 优先保障 ${ctx.top5[0].name.slice(0, 20)} 库存，避免断货`
    );
  }

  // ROI 优化
  if (ctx.roi !== null && ctx.roi < 2) {
    suggestions.push(
      `ROI 偏低 (${ctx.roi.toFixed(1)}x): 暂停低效广告位，加大自然流优化（SEO 标题/主图/价格）`
    );
  } else if (ctx.roi !== null && ctx.roi >= 3) {
    suggestions.push(
      `ROI 良好 (${ctx.roi.toFixed(1)}x): 可适当增加广告预算 20-30%`
    );
  }

  // 自然流占比
  if (ctx.organicRatio !== null && ctx.organicRatio < 60) {
    suggestions.push(
      `自然流占比偏低 (${ctx.organicRatio.toFixed(0)}%): 优化 SEO 标题 + 主图质量，提升自然搜索转化`
    );
  }

  // 调价节奏
  if (ctx.pricingAdjustments === 0) {
    suggestions.push(`本周未调价: 建议运行 /promo pricing 检查定价竞争力`);
  }

  // 文案优化
  if (ctx.copyOptimizations === 0) {
    suggestions.push(`热门商品建议优化俄语文案: /promo copy <offerId>`);
  }

  // 竞品监控
  suggestions.push(`保持竞品监控频率: /promo competitors 每周至少 2 次`);

  // RAG 知识库增强
  const topCategories = ctx.top5.map((p) => p.name.slice(0, 10)).join(",");
  const ragResults = await queryRag(config, "playbook", `周报优化建议 ${topCategories}`, { scenario: "promotion" });
  if (ragResults.length) {
    suggestions.push("\n💡 运营经验参考：");
    for (const r of ragResults) suggestions.push(`   • ${r.content.slice(0, 120)}`);
  }

  return suggestions;
}

// ---- 工具函数 ----

function fmtRub(n: number | null): string {
  return n === null ? "未知/同步失败" : `${n.toFixed(0)} ₽`;
}

function formatDiff(pct: number | null): string {
  if (pct === null) return "环比未知/同步失败";
  if (pct === 0) return "→0%";
  const sign = pct > 0 ? "↑" : "↓";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function getMonday(d: Date): string {
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0 days ago
  const monday = new Date(d);
  monday.setDate(d.getDate() - diff);
  return monday.toISOString().slice(0, 10);
}
