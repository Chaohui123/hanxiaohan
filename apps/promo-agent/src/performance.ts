import type { FeishuBot } from "@onzo/feishu-bot";
import type { ApiConfig } from "./api-client.js";
import { statsApi, promoApi } from "./api-client.js";
import { logger } from "@onzo/logger";

// ---- 类型 ----

export interface DailyReport {
  date: string;
  orders: number;
  revenue: number;
  avgOrderValue: number;
  topProducts: Array<{ offerId: string; name: string; orders: number; revenue: number }>;
  competitorChanges: number;
  pricingAdjustments: number;
  copyOptimizations: number;
  roi: number | null;
  adSpend: number;
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
let lastDailySent = ""; // date string YYYY-MM-DD
let lastWeeklySent = ""; // monday date string
let lastRetroDate = ""; // last retrospective date

// ---- 生命周期 ----

export function startPerformanceReports(bot: FeishuBot, chatId: string, config: ApiConfig): void {
  if (reportTimer) return;

  logger.info("Performance reports scheduler started");

  reportTimer = setInterval(() => {
    checkAndSend(bot, chatId, config).catch((err) => {
      logger.error({ err }, "Performance report check failed");
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

async function checkAndSend(bot: FeishuBot, chatId: string, config: ApiConfig): Promise<void> {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon

  // 09:00 日报
  if (hour === DAILY_HOUR && minute === 0) {
    const today = now.toISOString().slice(0, 10);
    if (lastDailySent !== today) {
      lastDailySent = today;
      await sendDailyReport(bot, chatId, config);
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

  // 周一 09:00 周报
  if (dayOfWeek === WEEKLY_DAY && hour === DAILY_HOUR && minute === 1) {
    const monday = getMonday(now);
    if (lastWeeklySent !== monday) {
      lastWeeklySent = monday;
      await sendWeeklyReport(bot, chatId, config);
    }
  }
}

// ---- 日报 ----

async function sendDailyReport(bot: FeishuBot, chatId: string, config: ApiConfig): Promise<void> {
  const yesterday = daysAgo(1);
  const yesterday2 = daysAgo(2);

  logger.info({ date: yesterday }, "Generating daily report");

  try {
    // 并行获取数据
    const [dailyData, prevDaily, pricingData, copyData, costData] = await Promise.all([
      statsApi.daily(config, yesterday).catch(() => null),
      statsApi.daily(config, yesterday2).catch(() => null),
      statsApi.pricingHistory(config, 1).catch(() => null),
      statsApi.copyHistory(config, 1).catch(() => null),
      statsApi.promoCost(config, yesterday, yesterday).catch(() => null),
    ]);

    const orders = dailyData?.orders || 0;
    const revenue = dailyData?.revenue || 0;
    const prevOrders = prevDaily?.orders || 0;
    const prevRevenue = prevDaily?.revenue || 0;

    const orderDiff = prevOrders > 0
      ? ((orders - prevOrders) / prevOrders * 100)
      : 0;
    const revenueDiff = prevRevenue > 0
      ? ((revenue - prevRevenue) / prevRevenue * 100)
      : 0;

    const avgOrderValue = orders > 0 ? revenue / orders : 0;

    // 竞品变动数（从定价历史中推断）
    const pricingAdjustments = pricingData?.adjustments?.length || 0;

    // 文案优化数
    const copyOptimizations = copyData?.copies?.length || 0;

    // ROI
    const adSpend = costData?.adSpend || 0;
    const roi = costData?.roi ?? (adSpend > 0 ? revenue / adSpend : null);

    const lines = [
      `📊 **日报 ${yesterday}**`,
      "",
      `📦 订单: **${orders}** 笔 ${formatDiff(orderDiff)}`,
      `💰 销售额: **${fmtRub(revenue)}** ${formatDiff(revenueDiff)}`,
      `🧾 客单价: ${fmtRub(avgOrderValue)}`,
      "",
      `📈 推广效果`,
      `🔥 广告花费: ${fmtRub(adSpend)}`,
      roi !== null ? `💎 ROI: **${roi.toFixed(2)}x**` : `💎 ROI: 暂无数据`,
      `🔧 调价: ${pricingAdjustments} 次`,
      `✍️ 文案优化: ${copyOptimizations} 次`,
      "",
    ];

    // Top 商品
    const tops = dailyData?.topProducts || [];
    if (tops.length > 0) {
      lines.push(`🏆 **Top 商品**`);
      tops.slice(0, 3).forEach((p, i) => {
        lines.push(`   ${i + 1}. ${p.name?.slice(0, 30) || p.offerId}: ${p.orders}笔 ${fmtRub(p.revenue)}`);
      });
      lines.push("");
    }

    lines.push(`💡 /promo — 查看推广总览 | /promo sales — 销售趋势`);

    await bot.sendMessage(chatId, lines.join("\n"));
    logger.info("Daily report sent");
  } catch (err) {
    logger.error({ err }, "Failed to send daily report");
    await bot.sendMessage(chatId, `⚠️ 日报生成失败: ${(err as Error).message}`).catch(() => {});
  }
}

// ---- 周报 ----

async function sendWeeklyReport(bot: FeishuBot, chatId: string, config: ApiConfig): Promise<void> {
  const from = daysAgo(7);
  const to = daysAgo(1);

  logger.info({ from, to }, "Generating weekly report");

  try {
    const [weeklyData, costData, pricingData, copyData] = await Promise.all([
      statsApi.weekly(config, from, to).catch(() => null),
      statsApi.promoCost(config, from, to).catch(() => null),
      statsApi.pricingHistory(config, 7).catch(() => null),
      statsApi.copyHistory(config, 7).catch(() => null),
    ]);

    const orders = weeklyData?.orders || 0;
    const revenue = weeklyData?.revenue || 0;

    // ROI
    const adSpend = costData?.adSpend || 0;
    const roi = costData?.roi ?? (adSpend > 0 ? revenue / adSpend : null);
    const organicRatio = costData?.organicRevenue && costData?.totalRevenue
      ? (costData.organicRevenue / costData.totalRevenue * 100)
      : null;

    // 调价与文案
    const pricingAdjustments = pricingData?.adjustments?.length || 0;
    const copyOptimizations = copyData?.copies?.length || 0;

    // 调价带来的销售增量
    const pricingSalesAfter = pricingData?.adjustments
      ?.reduce((sum, a) => sum + (a.salesAfter || 0), 0) || 0;

    const lines = [
      `📈 **周报 ${from} ~ ${to}**`,
      "",
      `📦 总订单: **${orders}** 笔`,
      `💰 总销售额: **${fmtRub(revenue)}**`,
      `🧾 日均: ${(orders / 7).toFixed(0)} 笔 / ${fmtRub(revenue / 7)}`,
      "",
      `📊 **推广效果**`,
      `🔥 广告花费: ${fmtRub(adSpend)}`,
      roi !== null ? `💎 ROI: **${roi.toFixed(2)}x**` : `💎 ROI: 暂无数据`,
      organicRatio !== null ? `🌿 自然流占比: **${organicRatio.toFixed(0)}%**` : "",
      `🔧 调价次数: ${pricingAdjustments}`,
      `✍️ 文案优化: ${copyOptimizations}`,
      pricingSalesAfter > 0 ? `📈 调价后增量: ${pricingSalesAfter} 笔` : "",
      "",
    ];

    // 7 天趋势
    const byDay = weeklyData?.byDay || [];
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

    // Top 5
    const top5 = weeklyData?.top5 || [];
    if (top5.length > 0) {
      lines.push(`🏆 **Top 5 热销**`);
      top5.forEach((p, i) => {
        lines.push(`   ${i + 1}. ${p.name?.slice(0, 25) || p.offerId}: ${p.orders}笔 ${fmtRub(p.revenue)}`);
      });
      lines.push("");
    }

    // Bottom 5
    const bottom5 = weeklyData?.bottom5 || [];
    if (bottom5.length > 0) {
      lines.push(`🐌 **滞销 Top 5**`);
      bottom5.forEach((p, i) => {
        lines.push(`   ${i + 1}. ${p.name?.slice(0, 25) || p.offerId}: ${p.orders}笔 库存${p.stock || 0}`);
      });
      lines.push("");
    }

    // 下周建议
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

    // 效果回溯摘要
    const pricingImproved = pricingData?.adjustments?.filter((a: Record<string, unknown>) => Number(a.salesAfter || 0) > Number(a.salesBefore || 0)).length || 0;
    const pricingTotal = pricingData?.adjustments?.length || 0;
    const copyImproved = copyData?.copies?.filter((c: Record<string, unknown>) => Number(c.salesAfter || 0) > Number(c.salesBefore || 0)).length || 0;
    const copyTotal = copyData?.copies?.length || 0;
    const allActions = [...(pricingData?.adjustments || []), ...(copyData?.copies || [])];
    const avgIncrement = allActions.length > 0
      ? (allActions.reduce((sum: number, a: Record<string, unknown>) => sum + (Number(a.salesAfter || 0) - Number(a.salesBefore || 0)), 0) / allActions.length).toFixed(1)
      : "0";

    lines.push("");
    // A/B 测试对比 (if enabled)
    if (process.env.PROMO_AB_TEST === "true") {
      const expActions = allActions.filter((a: Record<string, unknown>) => String(a.reason || "").includes("pricing") || String(a.reason || "").includes("copy"));
      const ctrlActions = allActions.filter((a: Record<string, unknown>) => String(a.reason || "").includes("control"));
      const expGrowth = expActions.length > 0
        ? (expActions.reduce((sum: number, a: Record<string, unknown>) => sum + (Number(a.salesAfter || 0) - Number(a.salesBefore || 0)), 0) / expActions.length).toFixed(1)
        : "0";
      const ctrlGrowth = ctrlActions.length > 0
        ? (ctrlActions.reduce((sum: number, a: Record<string, unknown>) => sum + (Number(a.salesAfter || 0) - Number(a.salesBefore || 0)), 0) / ctrlActions.length).toFixed(1)
        : "0";
      const netEffect = (parseFloat(expGrowth) - parseFloat(ctrlGrowth)).toFixed(1);

      lines.push("🧪 **A/B 测试结果**");
      lines.push(`实验组(推广): 平均增量 +${expGrowth}%`);
      lines.push(`对照组(无推广): 平均增量 +${ctrlGrowth}%`);
      lines.push(`推广净效果: +${netEffect}%`);
      lines.push("");
    }

    lines.push("📊 **推广效果回溯**");
    lines.push(`调价效果: ${pricingImproved}/${pricingTotal} 商品销量提升`);
    lines.push(`文案效果: ${copyImproved}/${copyTotal} 商品销量提升`);
    lines.push(`平均增量: +${avgIncrement}%`);
    lines.push("");

    lines.push(`💡 **下周推广建议**`);
    suggestions.forEach((s, i) => {
      lines.push(`   ${i + 1}. ${s}`);
    });

    await bot.sendMessage(chatId, lines.join("\n"));
    logger.info("Weekly report sent");
  } catch (err) {
    logger.error({ err }, "Failed to send weekly report");
    await bot.sendMessage(chatId, `⚠️ 周报生成失败: ${(err as Error).message}`).catch(() => {});
  }
}

// ---- 效果回溯 ----

async function runEffectRetrospective(config: ApiConfig): Promise<void> {
  try {
    const [pricingData, copyData] = await Promise.all([
      statsApi.pricingHistory(config, 7).catch(() => null),
      statsApi.copyHistory(config, 7).catch(() => null),
    ]);

    const pricingActions = pricingData?.adjustments || [];
    const copyActions = copyData?.copies || [];
    let updated = 0;

    for (const action of [...pricingActions, ...copyActions]) {
      const a = action as Record<string, unknown>;
      if (Number(a.salesAfter || a.salesAfter7d || 0) > 0) continue; // already retrospected

      const appliedDate = new Date(String(a.appliedAt || ""));
      if (isNaN(appliedDate.getTime())) continue;

      const sevenDaysLater = new Date(appliedDate.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (new Date() < sevenDaysLater) continue; // not yet 7 days

      // Get post-action sales from orders API
      let recentOrders = 0;
      try {
        const orders = await promoApi.orders(config, 7);
        const orderList = (orders as { orders?: Array<Record<string, unknown>> })?.orders || [];
        for (const o of orderList) {
          const orderDate = new Date(String(o.createdAt || o.created_at || ""));
          if (orderDate >= appliedDate && orderDate <= sevenDaysLater) {
            const items = (o.items || o.products || []) as Array<Record<string, unknown>>;
            for (const item of items) {
              if (String(item.offerId || item.offer_id || "") === String(a.offerId)) {
                recentOrders++;
              }
            }
          }
        }
      } catch { /* skip */ }

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

    // RAG 知识库增强：查询文案模板库对比效果
    if (updated > 0) {
      try {
        const ragResp = await fetch(`${config.apiBase}/api/rag/copy/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
          body: JSON.stringify({ query: "推广文案效果对比", topK: 3 }),
          signal: AbortSignal.timeout(5_000),
        });
        if (ragResp.ok) {
          const ragData = await ragResp.json() as { results?: Array<{ original_text?: string; content?: string }> };
          if (ragData.results?.length) {
            const copyTips = ragData.results.map((r) => r.original_text || r.content || "").filter(Boolean);
            if (copyTips.length > 0) {
              logger.info({ copyTips }, "RAG copy templates retrieved for retrospective");
            }
          }
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "RAG copy query degraded for retrospective");
      }
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
  orders: number;
  revenue: number;
  pricingAdjustments: number;
  copyOptimizations: number;
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

  // RAG 知识库增强：查询运营经验
  try {
    const topCategories = ctx.top5.map((p) => p.name.slice(0, 10)).join(",");
    const ragResp = await fetch(`${config.apiBase}/api/rag/playbook/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify({ query: `周报优化建议 ${topCategories}`, scenario: "promotion", topK: 3 }),
      signal: AbortSignal.timeout(5_000),
    });
    if (ragResp.ok) {
      const ragData = await ragResp.json() as { results?: Array<{ content: string }> };
      if (ragData.results?.length) {
        suggestions.push("\n💡 运营经验参考：");
        for (const r of ragData.results) {
          suggestions.push(`   • ${r.content.slice(0, 120)}`);
        }
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "RAG playbook query degraded for weekly suggestions");
  }

  return suggestions;
}

// ---- 工具函数 ----

function fmtRub(n: number): string {
  return `${n.toFixed(0)} ₽`;
}

function formatDiff(pct: number): string {
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
