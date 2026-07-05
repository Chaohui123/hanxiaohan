import type { FeishuBot, MsgContext } from "@onzo/feishu-bot";
import type { ApiConfig } from "./api-client.js";
import { promoApi, opsApi, competitorApi } from "./api-client.js";
import {
  isAutoPricingEnabled,
  setAutoPricingEnabled,
  handlePricingConfirmation,
} from "./smart-pricing.js";
import {
  generateCopy,
  analyzeImage,
  applyCopy,
  formatCopyResult,
  formatImageAnalysis,
} from "./copywriter.js";
import {
  isAutoDecisionEnabled,
  setAutoDecisionEnabled,
  getCurrentPlan,
  formatDecisionReport,
  scoreAllProducts,
} from "./decision-engine.js";
import { logger } from "@onzo/logger";

// ---- 竞品监控缓存 ----
const watchedOffers = new Set<string>();

export async function syncWatchList(config: ApiConfig): Promise<void> {
  try {
    const data = await competitorApi.getWatchList(config);
    watchedOffers.clear();
    for (const item of data.items || []) {
      watchedOffers.add(item.offerId);
    }
    logger.info({ count: watchedOffers.size }, "Watch list synced");
  } catch (err) {
    logger.warn({ err }, "Failed to sync watch list");
  }
}

function fmtRub(n: number): string {
  return `${n.toFixed(2)} ₽`;
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ---- 待确认的调价项 ----
const pendingPricing = new Map<string, () => Promise<string>>();

// ---- 注册命令 ----
export function registerCommands(bot: FeishuBot, config: ApiConfig): void {

  // === 消息处理 ===
  bot.onMessage(async (ctx: MsgContext) => {
    const text = ctx.text.trim();
    const lower = text.toLowerCase();

    // "yes" 确认处理
    if (lower === "yes" || lower === "是") {
      const key = `pricing_${ctx.chatId}`;
      const handler = pendingPricing.get(key);
      if (handler) {
        pendingPricing.delete(key);
        await bot.sendMessage(ctx.chatId, "⏳ 正在执行调价...");
        try {
          const result = await handler();
          await bot.sendMessage(ctx.chatId, result);
        } catch (err) {
          await bot.sendMessage(ctx.chatId, `❌ 执行失败: ${(err as Error).message}`);
        }
        return;
      }

      // 尝试智能定价确认
      await handlePricingConfirmation(bot, ctx.chatId, config, undefined).catch(() => {});
      return;
    }

    // "yes copy <offerId>" 确认文案上架
    const copyMatch = lower.match(/^(?:yes|是)\s+copy\s+(\S+)/);
    if (copyMatch) {
      const result = await applyCopy(bot, ctx.chatId, config, copyMatch[1]);
      await bot.sendMessage(ctx.chatId, stripMarkdown(result));
      return;
    }

    // 检查是否是 /promo 命令
    if (!lower.startsWith("/promo") && !lower.startsWith("promo")) {
      return; // 非命令消息静默
    }

    const args = parseArgs(lower);
    const sub = args[0];

    switch (sub) {
      case "competitors":
        await cmdCompetitors(bot, ctx.chatId, config);
        return;
      case "pricing":
        await cmdPricing(bot, ctx.chatId, config);
        return;
      case "copy":
        await cmdCopy(bot, ctx.chatId, config, args[1]);
        return;
      case "image":
        await cmdImage(bot, ctx.chatId, config, args[1]);
        return;
      case "sales":
        await cmdSales(bot, ctx.chatId, config);
        return;
      case "roi":
        await cmdRoi(bot, ctx.chatId);
        return;
      case "watch":
        await cmdWatch(bot, ctx.chatId, config, args[1]);
        return;
      case "unwatch":
        await cmdUnwatch(bot, ctx.chatId, config, args[1]);
        return;
      case "pause":
        await cmdPause(bot, ctx.chatId);
        return;
      case "resume":
        await cmdResume(bot, ctx.chatId);
        return;
      case "audit":
      case "推广审计":
        await cmdAudit(bot, ctx.chatId);
        return;
      case "auto":
        await cmdAuto(bot, ctx.chatId, config, args[1]);
        return;
      case "help":
      case "帮助":
        await cmdHelp(bot, ctx.chatId);
        return;
      case "start":
      case "status":
      case "状态":
        await cmdStatus(bot, ctx.chatId, config);
        return;
      default:
        await cmdOverview(bot, ctx.chatId, config);
    }
  });

  // === 卡片按钮回调 ===
  bot.onCardAction(async (action) => {
    const chatId = action.chatId;
    if (!chatId) return;

    // 推广决策卡片按钮
    if (action.action === "execute_plan") {
      const planId = action.value?.planId as string || "";
      await bot.sendMessage(chatId, `⏳ 正在执行决策计划 ${planId.slice(-8)}...`);
      try {
        // 触发手动决策
        const scored = await scoreAllProducts(config);
        const top5 = scored.filter((p) => p.recommendation !== "skip").slice(0, 5);
        await bot.sendMessage(chatId, `✅ 已执行决策，共评分 ${scored.length} 件商品，推荐 ${top5.length} 项操作`);
      } catch (err) {
        await bot.sendMessage(chatId, `❌ 执行失败: ${(err as Error).message}`);
      }
      return;
    }

    if (action.action === "cancel_plan") {
      await bot.sendMessage(chatId, "⏸ 已取消当前决策计划");
      return;
    }

    // 原有的 pending 确认处理
    const key = `${action.action}_${chatId}`;
    const handler = pendingPricing.get(key);
    if (!handler) {
      await bot.sendMessage(chatId, "⏰ 该确认已过期，请重新发送命令");
      return;
    }

    pendingPricing.delete(key);
    await bot.sendMessage(chatId, "⏳ 正在执行...");

    try {
      const result = await handler();
      await bot.sendMessage(chatId, result);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ 执行失败: ${(err as Error).message}`);
    }
  });
}

// ---- 命令实现 ----

async function cmdHelp(bot: FeishuBot, chatId: string): Promise<void> {
  await bot.sendMessage(chatId, [
    "🎯 ONZO 推广竞价 Agent",
    "",
    "📊 查询命令：",
    "/promo — 推广总览（商品数/订单/库存预警）",
    "/promo competitors — 竞品价格对比",
    "/promo pricing — 智能定价建议",
    "/promo sales — 近7天销售趋势",
    "/promo roi — 推广ROI报告",
    "/status — 系统组件状态",
    "",
    "✍️ 内容生成：",
    "/promo copy <offerId> — 俄语营销文案",
    "/promo image <offerId> — 主图质量分析",
    "",
    "🔧 控制：",
    "/promo watch <offerId> — 添加竞品监控",
    "/promo unwatch <offerId> — 移除竞品监控",
    "/promo pause — 暂停自动调价",
    "/promo resume — 恢复自动调价",
    "",
    "🛡️ 合规：",
    "/promo audit — 合规词库概览",
    "",
    "🧠 自主决策：",
    "/promo auto — 查看状态",
    "/promo auto on/off/run/plan",
  ].join("\n"));
}

async function cmdStatus(bot: FeishuBot, chatId: string, config: ApiConfig): Promise<void> {
  try {
    const data = await opsApi.ready(config);
    const checks = (data.checks as Record<string, { status: string; latencyMs?: number }>) || {};
    const lines = Object.entries(checks).map(([name, c]) => {
      const emoji = c.status === "ok" ? "✅" : "❌";
      const latency = c.latencyMs ? ` (${c.latencyMs}ms)` : "";
      return `${emoji} ${name}: ${c.status}${latency}`;
    }).join("\n");

    await bot.sendMessage(chatId, [
      `📊 系统状态 — ${data.status}`,
      "",
      lines,
      "",
      `🔄 自动调价: ${isAutoPricingEnabled() ? "▶ 运行中" : "⏸ 已暂停"}`,
      `🧠 自主决策: ${isAutoDecisionEnabled() ? "▶ 运行中" : "⏸ 已暂停"}`,
    ].join("\n"));
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 状态查询失败: ${(err as Error).message}`);
  }
}

/** /promo — 推广总览 */
async function cmdOverview(bot: FeishuBot, chatId: string, config: ApiConfig): Promise<void> {
  try {
    const [dashboard, products, alerts] = await Promise.all([
      promoApi.dashboard(config).catch(() => null),
      promoApi.products(config).catch(() => null),
      promoApi.inventoryAlerts(config).catch(() => null),
    ]);

    const d = dashboard as Record<string, unknown> | null;
    const p = products as { items?: unknown[] } | null;
    const a = alerts as { alerts?: unknown[] } | null;

    await bot.sendMessage(chatId, [
      "🎯 推广总览",
      "",
      `📦 在售商品: ${p?.items?.length ?? "?"} 件`,
      `📋 今日订单: ${d?.todayOrders ?? "?"} 笔`,
      `💰 今日销售额: ${d?.todayRevenue ? fmtRub(Number(d.todayRevenue)) : "?"}`,
      `⚠️ 库存预警: ${a?.alerts?.length ?? "?"} 项`,
      "",
      `🔄 自动调价: ${isAutoPricingEnabled() ? "▶ 运行中" : "⏸ 已暂停"}`,
      `🧠 自主决策: ${isAutoDecisionEnabled() ? "▶ 运行中" : "⏸ 已暂停"}`,
      `👁 竞品监控: ${watchedOffers.size} 个`,
      "",
      "子命令: competitors | pricing | copy | image | sales | roi | watch | unwatch | pause | resume | audit | auto",
    ].join("\n"));
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 查询失败: ${(err as Error).message}`);
  }
}

/** /promo competitors — 竞品价格对比 */
async function cmdCompetitors(bot: FeishuBot, chatId: string, config: ApiConfig): Promise<void> {
  if (watchedOffers.size === 0) {
    await bot.sendMessage(chatId, "👁 暂无监控商品。使用 /promo watch <offerId> 添加竞品监控。");
    return;
  }

  try {
    const products = await promoApi.products(config).catch(() => null);
    const items = (products as { items?: Array<Record<string, unknown>> })?.items || [];
    const watched = items.filter((item) =>
      watchedOffers.has(String(item.offerId || item.offer_id || "")),
    );

    if (watched.length === 0) {
      await bot.sendMessage(chatId, "⚠️ 监控的商品未找到数据。");
      return;
    }

    const lines = ["📊 竞品价格对比", ""];
    for (const w of watched) {
      const myPrice = Number(w.price || 0);
      const offerId = String(w.offerId || w.offer_id || "");

      let compPrice = 0;
      try {
        const priceData = await competitorApi.getPrices(config, offerId, 1);
        const recentPrices = priceData.prices || [];
        if (recentPrices.length > 0) {
          compPrice = recentPrices.reduce((s, p) => s + p.price, 0) / recentPrices.length;
        }
      } catch {
        compPrice = Number(w.competitorPrice || w.competitor_price || 0);
      }

      const diff = compPrice > 0 ? ((myPrice - compPrice) / compPrice * 100).toFixed(1) : "—";
      const name = String(w.name || w.title || w.offerId || "—").slice(0, 40);
      lines.push(
        `${myPrice > compPrice ? "🔴" : "🟢"} ${name}`,
        `   我的: ${fmtRub(myPrice)} | 竞品均: ${fmtRub(compPrice)} | 差: ${diff}%`,
      );
    }
    await bot.sendMessage(chatId, lines.join("\n"));
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 查询失败: ${(err as Error).message}`);
  }
}

/** /promo pricing — 智能定价建议 */
async function cmdPricing(bot: FeishuBot, chatId: string, config: ApiConfig): Promise<void> {
  try {
    const [products, fx] = await Promise.all([
      promoApi.products(config).catch(() => null),
      promoApi.exchangeRate(config).catch(() => null),
    ]);

    const items = (products as { items?: Array<Record<string, unknown>> })?.items || [];
    const rate = Number((fx as Record<string, unknown>)?.rate || 0);

    if (items.length === 0) {
      await bot.sendMessage(chatId, "📦 暂无在售商品。");
      return;
    }

    const lines = [
      "💡 智能定价建议",
      rate > 0 ? `💱 当前汇率: 1 CNY = ${rate.toFixed(2)} RUB` : "",
      "",
    ];

    const withCost = items.filter((item) => Number(item.cost || 0) > 0).slice(0, 5);

    if (withCost.length === 0) {
      lines.push("⚠️ 无成本数据，无法生成定价建议。");
    } else {
      for (const item of withCost) {
        const cost = Number(item.cost || 0);
        const currentPrice = Number(item.price || 0);
        const suggested = Math.round(cost * 1.3 * (rate > 0 ? rate : 12));
        const diff = currentPrice > 0
          ? ((suggested - currentPrice) / currentPrice * 100).toFixed(0)
          : "—";
        const name = String(item.name || item.title || item.offerId || "—").slice(0, 35);
        lines.push(
          `📦 ${name}`,
          `   成本: ${fmtRub(cost)} → 建议: ${fmtRub(suggested)} (${diff}%)`,
        );
      }
    }

    lines.push("", `🔄 自动调价: ${isAutoPricingEnabled() ? "运行中" : "已暂停"}`);
    await bot.sendMessage(chatId, lines.join("\n"));
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 查询失败: ${(err as Error).message}`);
  }
}

/** /promo copy <offerId> — 生成俄语营销文案 */
async function cmdCopy(bot: FeishuBot, chatId: string, config: ApiConfig, offerId?: string): Promise<void> {
  if (!offerId) {
    await bot.sendMessage(chatId, "⚠️ 用法: /promo copy <offerId>");
    return;
  }

  await bot.sendMessage(chatId, `⏳ 正在为 ${offerId} 生成俄语营销文案...`);

  try {
    const copy = await generateCopy(config, offerId, chatId);
    if (!copy) {
      await bot.sendMessage(chatId, "❌ 文案生成失败，请检查商品是否存在。");
      return;
    }
    await bot.sendMessage(chatId, stripMarkdown(formatCopyResult(copy)));
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 文案生成失败: ${(err as Error).message}`);
  }
}

/** /promo image <offerId> — 分析商品主图质量 */
async function cmdImage(bot: FeishuBot, chatId: string, config: ApiConfig, offerId?: string): Promise<void> {
  if (!offerId) {
    await bot.sendMessage(chatId, "⚠️ 用法: /promo image <offerId>");
    return;
  }

  await bot.sendMessage(chatId, `⏳ 正在分析 ${offerId} 主图质量...`);

  try {
    const analysis = await analyzeImage(config, offerId);
    if (!analysis) {
      await bot.sendMessage(chatId, "❌ 图片分析失败。");
      return;
    }
    await bot.sendMessage(chatId, stripMarkdown(formatImageAnalysis(analysis)));
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 图片分析失败: ${(err as Error).message}`);
  }
}

/** /promo sales — 近7天销售趋势 */
async function cmdSales(bot: FeishuBot, chatId: string, config: ApiConfig): Promise<void> {
  try {
    const data = await promoApi.orders(config, 7).catch(() => null);
    const orders = (data as { orders?: Array<Record<string, unknown>> })?.orders || [];

    if (orders.length === 0) {
      await bot.sendMessage(chatId, "📉 近7天暂无订单。");
      return;
    }

    const byDay = new Map<string, { count: number; revenue: number }>();
    for (const o of orders) {
      const date = String(o.createdAt || o.created_at || "").slice(0, 10);
      if (!date) continue;
      const entry = byDay.get(date) || { count: 0, revenue: 0 };
      entry.count++;
      entry.revenue += Number(o.total || o.price || 0);
      byDay.set(date, entry);
    }

    const sorted = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    const lines = ["📈 近7天销售趋势", ""];
    let totalRev = 0;
    for (const [date, entry] of sorted) {
      totalRev += entry.revenue;
      const bar = "█".repeat(Math.min(entry.count, 20));
      lines.push(`${date}  ${bar}  ${entry.count}笔  ${fmtRub(entry.revenue)}`);
    }
    lines.push("", `💰 7天总计: ${fmtRub(totalRev)} | ${orders.length} 笔订单`);

    await bot.sendMessage(chatId, lines.join("\n"));
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 查询失败: ${(err as Error).message}`);
  }
}

/** /promo roi — 推广ROI报告 */
async function cmdRoi(bot: FeishuBot, chatId: string): Promise<void> {
  await bot.sendMessage(chatId, [
    "📊 推广ROI报告",
    "",
    "⏳ ROI计算引擎接入中（后续实现）",
    "",
    "将分析：",
    "- 广告花费 vs 销售额",
    "- 自然流 vs 付费流占比",
    "- 单品ROI排名",
    "- 优化建议",
  ].join("\n"));
}

/** /promo watch <offerId> — 添加竞品监控 */
async function cmdWatch(bot: FeishuBot, chatId: string, config: ApiConfig, offerId?: string): Promise<void> {
  if (!offerId) {
    await bot.sendMessage(chatId, "⚠️ 用法: /promo watch <offerId>");
    return;
  }

  try { await competitorApi.addWatch(config, offerId); } catch { /* fallback */ }
  watchedOffers.add(offerId);
  await bot.sendMessage(chatId, `👁 已添加竞品监控: ${offerId}\n当前监控 ${watchedOffers.size} 个商品。`);
}

/** /promo unwatch <offerId> — 移除竞品监控 */
async function cmdUnwatch(bot: FeishuBot, chatId: string, config: ApiConfig, offerId?: string): Promise<void> {
  if (!offerId) {
    await bot.sendMessage(chatId, "⚠️ 用法: /promo unwatch <offerId>");
    return;
  }

  try { await competitorApi.removeWatch(config, offerId); } catch { /* fallback */ }
  watchedOffers.delete(offerId);
  await bot.sendMessage(chatId, `👁 已移除竞品监控: ${offerId}\n当前监控 ${watchedOffers.size} 个商品。`);
}

/** /promo pause — 暂停自动调价 */
async function cmdPause(bot: FeishuBot, chatId: string): Promise<void> {
  setAutoPricingEnabled(false);
  logger.info("Auto pricing paused");
  await bot.sendMessage(chatId, "⏸ 已暂停所有自动调价。使用 /promo resume 恢复。");
}

/** /promo resume — 恢复自动调价 */
async function cmdResume(bot: FeishuBot, chatId: string): Promise<void> {
  setAutoPricingEnabled(true);
  logger.info("Auto pricing resumed");
  await bot.sendMessage(chatId, "▶ 已恢复自动调价。");
}

/** /promo audit — 合规审计词库概览 */
async function cmdAudit(bot: FeishuBot, chatId: string): Promise<void> {
  const { RUSSIAN_AD_LAW, OZON_PLATFORM_RULES, CHINA_AD_LAW } = await import("./compliance/word-lists.js");
  const total = RUSSIAN_AD_LAW.length + OZON_PLATFORM_RULES.length + CHINA_AD_LAW.length;
  const blocked = [...RUSSIAN_AD_LAW, ...OZON_PLATFORM_RULES, ...CHINA_AD_LAW].filter((v) => v.severity === "block").length;
  const warned = total - blocked;

  await bot.sendMessage(chatId, [
    "🛡️ 合规审计词库",
    "",
    `🇷🇺 俄罗斯广告法: ${RUSSIAN_AD_LAW.length} 条`,
    `🛒 Ozon平台规则: ${OZON_PLATFORM_RULES.length} 条`,
    `🇨🇳 中国广告法: ${CHINA_AD_LAW.length} 条`,
    "",
    `❌ 阻断词: ${blocked} 条（发现即禁止发布）`,
    `⚠️ 警告词: ${warned} 条（建议修改）`,
    "",
    "所有AI生成的文案在发布前会自动审计，未通过的禁止提交到Ozon",
  ].join("\n"));
}

/** /promo auto [on|off|run|plan] — 自主决策引擎控制 */
async function cmdAuto(bot: FeishuBot, chatId: string, config: ApiConfig, subCommand?: string): Promise<void> {
  switch (subCommand) {
    case "on":
      setAutoDecisionEnabled(true);
      await bot.sendMessage(chatId, "🧠 自主推广决策已启用。系统将自动分析商品、生成分数、交叉验证后执行推广。");
      return;

    case "off":
      setAutoDecisionEnabled(false);
      await bot.sendMessage(chatId, "⏸ 自主推广决策已暂停。");
      return;

    case "run": {
      await bot.sendMessage(chatId, "⏳ 正在执行自主推广决策...");
      const scored = await scoreAllProducts(config);
      const top5 = scored.filter((p) => p.recommendation !== "skip").slice(0, 5);
      if (top5.length === 0) {
        await bot.sendMessage(chatId, "📊 当前无适合推广的商品");
        return;
      }
      const lines = ["🧠 推广优先级排行", ""];
      for (const p of top5) {
        const emoji = p.recommendation === "copy" ? "✍️"
          : p.recommendation === "pricing" ? "💰"
          : p.recommendation === "copy_and_pricing" ? "🎯" : "⏭";
        lines.push(
          `${emoji} ${p.name.slice(0, 30)} — ${p.totalScore}分`,
          `   利润${p.breakdown.margin} | 价格${p.breakdown.priceAdvantage} | 库存${p.breakdown.stock}`,
          `   ${p.reason}`,
        );
      }
      await bot.sendMessage(chatId, lines.join("\n"));
      return;
    }

    case "plan": {
      const plan = getCurrentPlan();
      if (!plan) {
        await bot.sendMessage(chatId, "📋 暂无活跃的决策计划");
        return;
      }
      await bot.sendMessage(chatId, stripMarkdown(formatDecisionReport(plan)));
      return;
    }

    default:
      await bot.sendMessage(chatId, [
        "🧠 自主推广决策",
        "",
        `状态: ${isAutoDecisionEnabled() ? "▶ 运行中" : "⏸ 已暂停"}`,
        "",
        "子命令:",
        "on — 启用自主决策",
        "off — 暂停自主决策",
        "run — 手动触发评分",
        "plan — 查看当前计划",
      ].join("\n"));
  }
}

// ---- 工具函数 ----

function parseArgs(text: string): string[] {
  // "/promo competitors" 或 "/promo copy abc123"
  const parts = text.split(/\s+/);
  return parts.slice(1);
}

/** 去除 Markdown 格式标记（飞书文本消息不支持 Markdown） */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1");
}
