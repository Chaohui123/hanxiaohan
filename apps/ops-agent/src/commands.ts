import type { FeishuBot, MsgContext } from "@onzo/feishu-bot";
import type { ApiConfig } from "./api-client.js";
import { apiClient } from "./api-client.js";
import { aiDiagnose } from "./ai-diagnose.js";
import { forwardPromoCommand } from "@onzo/feishu-bot/router.js";
import { logger } from "@onzo/logger";

function statusEmoji(ok: boolean): string {
  return ok ? "✅" : "❌";
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const HELP_TEXT = [
  "📊 查询命令：",
  "status / 状态 — 系统组件状态",
  "diagnose / 诊断 — AI 完整自检",
  "orders / 订单 — 待发货订单",
  "inventory / 库存 — 库存预警",
  "metrics / 用量 — Token 用量/费用",
  "tasks / 任务 — 任务队列",
  "pipeline / 管线 — 外部依赖检查",
  "",
  "⚠️ 执行命令（需确认）：",
  "backup / 备份 — 手动触发备份",
  "sync / 同步 — 手动触发订单同步",
  "reconcile / 对账 — 手动触发财务对账",
  "",
  "help / 帮助 — 显示此消息",
].join("\n");

export function registerCommands(bot: FeishuBot, config: ApiConfig): void {
  // ---- Pending confirmations ----
  const pending = new Map<string, { action: string; handler: () => Promise<string> }>();

  // ---- Message handler ----
  bot.onMessage(async (ctx: MsgContext) => {
    // Forward promo-agent commands via shared router
    if (await forwardPromoCommand(ctx.text, { chatId: ctx.chatId, messageId: ctx.messageId, senderOpenId: ctx.senderOpenId })) {
      return;
    }

    // Process "yes" confirmation
    if (ctx.text.toLowerCase() === "yes") {
      for (const prefix of ["backup", "sync", "reconcile"]) {
        const key = `${prefix}_${ctx.chatId}`;
        const entry = pending.get(key);
        if (entry) {
          pending.delete(key);
          await bot.sendMessage(ctx.chatId, `⏳ 正在执行 ${entry.action}...`);
          try {
            const result = await entry.handler();
            await bot.sendMessage(ctx.chatId, result);
          } catch (err) {
            await bot.sendMessage(ctx.chatId, `❌ 执行失败: ${(err as Error).message}`);
          }
          return;
        }
      }
    }

    // Match command keyword
    const cmd = ctx.text.toLowerCase().replace(/^[@\s]+/, "").trim();

    switch (cmd) {
      case "help":
      case "帮助":
        await bot.sendMessage(ctx.chatId, HELP_TEXT);
        return;

      case "status":
      case "状态":
        await handleStatus(bot, ctx.chatId, config);
        return;

      case "diagnose":
      case "诊断":
        await handleDiagnose(bot, ctx.chatId, config);
        return;

      case "orders":
      case "订单":
        await handleOrders(bot, ctx.chatId, config);
        return;

      case "inventory":
      case "库存":
        await handleInventory(bot, ctx.chatId, config);
        return;

      case "metrics":
      case "用量":
        await handleMetrics(bot, ctx.chatId, config);
        return;

      case "tasks":
      case "任务":
        await handleTasks(bot, ctx.chatId, config);
        return;

      case "pipeline":
      case "管线":
        await handlePipeline(bot, ctx.chatId, config);
        return;

      case "backup":
      case "备份":
        pending.set(`backup_${ctx.chatId}`, {
          action: "手动备份",
          handler: async () => {
            const r = await apiClient.backup(config);
            return `✅ 备份已触发: ${(r as { filename?: string }).filename || "ok"}`;
          },
        });
        await bot.sendConfirmCard(
          ctx.chatId,
          "⚠️ 确认手动备份",
          "将立即触发数据库备份操作",
          "backup",
        );
        return;

      case "sync":
      case "同步":
        pending.set(`sync_${ctx.chatId}`, {
          action: "订单同步",
          handler: async () => {
            const r = await apiClient.syncOrders(config);
            return `✅ 同步已触发: ${(r as { synced?: number }).synced || 0} 笔`;
          },
        });
        await bot.sendConfirmCard(
          ctx.chatId,
          "⚠️ 确认订单同步",
          "将立即从 Ozon 平台同步最新订单",
          "sync",
        );
        return;

      case "reconcile":
      case "对账": {
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000)
          .toISOString()
          .slice(0, 10);
        pending.set(`reconcile_${ctx.chatId}`, {
          action: "财务对账",
          handler: async () => {
            const r = await apiClient.reconcile(config, yesterday, today);
            return `✅ 对账完成: 匹配 ${(r as { matched?: number }).matched || 0} 笔`;
          },
        });
        await bot.sendConfirmCard(
          ctx.chatId,
          "⚠️ 确认财务对账",
          `对账范围: ${yesterday} ~ ${today}`,
          "reconcile",
        );
        return;
      }

      default:
        // Unknown command — show help
        await bot.sendMessage(ctx.chatId, `未知命令: "${ctx.text}"\n\n${HELP_TEXT}`);
    }
  });

  // ---- Card action handler (button clicks) ----
  bot.onCardAction(async (action) => {
    // Card action doesn't have a key-based lookup since chatId comes from event
    // We handle the action value directly
    const chatId = action.chatId;
    if (!chatId) return;

    const key = `${action.action}_${chatId}`;
    const entry = pending.get(key);
    if (!entry) {
      await bot.sendMessage(chatId, "⏰ 该确认已过期，请重新发送命令");
      return;
    }

    pending.delete(key);
    await bot.sendMessage(chatId, `⏳ 正在执行 ${entry.action}...`);

    try {
      const result = await entry.handler();
      await bot.sendMessage(chatId, result);
    } catch (err) {
      await bot.sendMessage(
        chatId,
        `❌ 执行失败: ${(err as Error).message}`,
      );
    }
  });
}

// ---- Command handlers ----

async function handleStatus(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
): Promise<void> {
  try {
    const data = await apiClient.ready(config);
    const checks =
      (data.checks as Record<string, { status: string; latencyMs?: number }>) || {};
    const lines = Object.entries(checks).map(
      ([name, c]) =>
        `${statusEmoji(c.status === "ok")} ${name}: ${c.status}${
          c.latencyMs ? ` (${c.latencyMs}ms)` : ""
        }`,
    );
    await bot.sendMessage(
      chatId,
      `📊 系统状态 — ${data.status}\n\n${lines.join("\n")}` +
        `\n\n⏱ Uptime: ${fmtDuration((data.uptime as number) || 0)}`,
    );
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 无法获取状态: ${(err as Error).message}`);
  }
}

async function handleDiagnose(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
): Promise<void> {
  await bot.sendMessage(chatId, "🔍 正在运行完整自检...");
  try {
    const data = await apiClient.diagnose(config);
    const summary = await aiDiagnose(config, JSON.stringify(data, null, 2));
    await bot.sendMessage(chatId, summary);
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 自检失败: ${(err as Error).message}`);
  }
}

async function handleOrders(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
): Promise<void> {
  try {
    const data = await apiClient.orders(config, "awaiting_deliver");
    const orders = (data as { orders?: unknown[] }).orders || [];
    await bot.sendMessage(chatId, `📦 待发货订单: ${orders.length} 笔`);
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 查询失败: ${(err as Error).message}`);
  }
}

async function handleInventory(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
): Promise<void> {
  try {
    const data = await apiClient.inventoryAlerts(config);
    const alerts =
      (data as { alerts?: Array<{ offerId: string; sku: string; stock: number }> })
        .alerts || [];
    if (alerts.length === 0) {
      await bot.sendMessage(chatId, "📦 库存正常，无预警");
      return;
    }
    const lines = alerts.slice(0, 20).map(
      (a) =>
        `${a.stock === 0 ? "🔴" : "🟡"} ${a.offerId}/${a.sku}: 库存 ${a.stock}`,
    );
    await bot.sendMessage(
      chatId,
      `📦 库存预警 (${alerts.length} 项)\n\n${lines.join("\n")}` +
        (alerts.length > 20 ? `\n... 还有 ${alerts.length - 20} 项` : ""),
    );
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 查询失败: ${(err as Error).message}`);
  }
}

async function handleMetrics(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
): Promise<void> {
  try {
    const data = await apiClient.llmStats(config);
    await bot.sendMessage(
      chatId,
      `💰 Token 用量\n\n今日: ${data.todayTokens || 0} tokens\n` +
        `费用: ¥${data.todayCost || 0}\n` +
        `限额: ${data.dailyLimit || "无"}`,
    );
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 查询失败: ${(err as Error).message}`);
  }
}

async function handleTasks(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
): Promise<void> {
  try {
    const data = await apiClient.taskStats(config);
    await bot.sendMessage(
      chatId,
      `📋 任务队列\n\n待处理: ${data.pending || 0}\n` +
        `运行中: ${data.running || 0}\n` +
        `已完成: ${data.completed || 0}\n` +
        `失败: ${data.failed || 0}`,
    );
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 查询失败: ${(err as Error).message}`);
  }
}

async function handlePipeline(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
): Promise<void> {
  try {
    const data = await apiClient.pipelineHealth(config);
    const checks =
      (data.checks as Record<string, { status: string; latencyMs?: number }>) || {};
    const lines = Object.entries(checks).map(
      ([name, c]) =>
        `${statusEmoji(c.status === "ok")} ${name}: ${c.status}${
          c.latencyMs ? ` (${c.latencyMs}ms)` : ""
        }`,
    );
    await bot.sendMessage(chatId, `🔗 管线检查\n\n${lines.join("\n")}`);
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 检查失败: ${(err as Error).message}`);
  }
}
