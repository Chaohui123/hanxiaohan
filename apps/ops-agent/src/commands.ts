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
  "📦 上架命令：",
  "select <关键词> / 选品 — 自动搜索1688并上架",
  "listing <1688链接> — 提交1688商品上架",
  "listing status <任务ID> — 查询上架进度",
  "listing recent — 最近上架记录",
  "",
  "⚠️ 执行命令（需确认）：",
  "backup / 备份 — 手动触发备份",
  "sync / 同步 — 手动触发订单同步",
  "reconcile / 对账 — 手动触发财务对账",
  "logistics / 物流 — 采购物流状态",
  "cleanup / 清理 — 清理过期临时文件",
  "",
  "help / 帮助 — 显示此消息",
].join("\n");

const LISTING_URL_RE = /^https?:\/\/(?:detail\.)?1688\.com\b/;

export function registerCommands(bot: FeishuBot, config: ApiConfig): void {
  // ---- Pending confirmations ----
  const pending = new Map<string, { action: string; handler: () => Promise<string> }>();

  // ---- Message handler ----
  bot.onMessage(async (ctx: MsgContext) => {
    // Forward promo-agent commands via shared router
    if (await forwardPromoCommand(ctx.text, { chatId: ctx.chatId, messageId: ctx.messageId, senderOpenId: ctx.senderOpenId })) {
      return;
    }

    // Process "yes" / "是" / "确认" confirmation
    const confirmLower = ctx.text.toLowerCase().trim();
    if (confirmLower === "yes" || confirmLower === "是" || confirmLower === "确认") {
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

    // 自动选品（关键词 → 搜索1688 → 自动上架）
    if (cmd.startsWith("select") || cmd.startsWith("选品")) {
      const keyword = ctx.text.split(/\s+/).slice(1).join(" ");
      await handleAutoSelect(bot, ctx.chatId, config, keyword);
      return;
    }

    // 上架命令（支持子命令 + URL）
    if (cmd.startsWith("listing") || cmd.startsWith("上架")) {
      const listingArgs = ctx.text.split(/\s+/).slice(1);
      await handleListing(bot, ctx.chatId, config, listingArgs);
      return;
    }

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

      case "logistics":
      case "物流":
        try {
          const data = await apiClient.healthPanel(config);
          const listResp = await fetch(`${config.apiBase}/api/purchase/list?status=paid&limit=10`, {
            headers: { "X-API-Key": config.apiKey },
            signal: AbortSignal.timeout(15_000),
          });
          const list = (await listResp.json().catch(() => ({}))) as { data?: Array<{ ozon_posting_number: string; logistics_status: string; logistics_tracking: string | null }> };
          const items = list.data || [];
          if (items.length === 0) {
            await bot.sendMessage(ctx.chatId, "📦 无待追踪采购单");
            return;
          }
          const lines = items.map((p) => {
            const s = p.logistics_status === "shipped" ? "✅" : p.logistics_tracking ? "📮" : "⏳";
            return `${s} ${p.ozon_posting_number}: ${p.logistics_status || "idle"}${p.logistics_tracking ? ` (${p.logistics_tracking})` : ""}`;
          });
          await bot.sendMessage(ctx.chatId, `📦 采购物流状态 (最近10笔)\n\n${lines.join("\n")}`);
        } catch (err) {
          await bot.sendMessage(ctx.chatId, `❌ 查询失败: ${(err as Error).message}`);
        }
        return;

      case "cleanup":
      case "清理":
        pending.set(`cleanup_${ctx.chatId}`, {
          action: "临时文件清理",
          handler: async () => {
            const r = await apiClient.cleanup(config);
            const d = (r as { data?: { tmpImages?: { deleted: number; freedKB: number }; deadLetter?: { deleted: number }; failedTasks?: { deleted: number } } }).data || {};
            return `✅ 清理完成\n📷 临时图片: ${d.tmpImages?.deleted || 0} 个 (${d.tmpImages?.freedKB || 0}KB)\n📁 死信: ${d.deadLetter?.deleted || 0} 个\n🗃️ 失败任务: ${d.failedTasks?.deleted || 0} 条`;
          },
        });
        await bot.sendConfirmCard(ctx.chatId, "⚠️ 确认清理临时文件", "将删除过期临时图片、死信和失败任务记录", "cleanup");
        return;

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
    const checks = (data.checks as Record<string, unknown>) || {};
    const lines = Object.entries(checks).map(([name, c]) => {
      const st = typeof c === "string" ? c : (c as { status?: string }).status || "unknown";
      const lat = typeof c === "object" ? (c as { latencyMs?: number }).latencyMs : undefined;
      return `${statusEmoji(st === "ok")} ${name}: ${st}${lat ? ` (${lat}ms)` : ""}`;
    });
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

async function handleListing(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
  args: string[],
): Promise<void> {
  const sub = args[0]?.toLowerCase();

  // listing status <taskId>
  if (sub === "status") {
    const taskId = args[1];
    if (!taskId) {
      await bot.sendMessage(chatId, "⚠️ 用法: listing status <任务ID>");
      return;
    }
    try {
      const data = await apiClient.taskProgress(config, taskId);
      const status = (data as { status?: string; error_message?: string; progress?: number }).status || "unknown";
      const error = (data as { error_message?: string }).error_message || "";
      const progress = (data as { progress?: number }).progress;
      const lines = [
        `📦 上架进度 — ${taskId}`,
        `状态: ${status}`,
        progress != null ? `进度: ${progress}%` : "",
        error ? `错误: ${error}` : "",
      ].filter(Boolean);
      await bot.sendMessage(chatId, lines.join("\n"));
    } catch (err) {
      await bot.sendMessage(chatId, `❌ 查询失败: ${(err as Error).message}`);
    }
    return;
  }

  // listing recent
  if (sub === "recent") {
    try {
      const data = await apiClient.recentListings(config, 5);
      const items = (data as { items?: Array<{ sourceUrl: string; status: string; title?: string; taskId?: string }> }).items || [];
      if (items.length === 0) {
        await bot.sendMessage(chatId, "📦 暂无上架记录");
        return;
      }
      const lines = ["📦 最近上架", ""];
      for (const item of items) {
        const emoji = item.status === "done" ? "✅"
          : item.status === "failed" ? "❌"
          : item.status === "processing" ? "⏳"
          : "📌";
        const title = (item.title || item.sourceUrl || "").slice(0, 40);
        lines.push(`${emoji} ${title}\n   ${item.status} | ${item.taskId || ""}`);
      }
      await bot.sendMessage(chatId, lines.join("\n"));
    } catch (err) {
      await bot.sendMessage(chatId, `❌ 查询失败: ${(err as Error).message}`);
    }
    return;
  }

  // listing <1688-url> — submit
  const url = args[0];
  if (!url || !LISTING_URL_RE.test(url)) {
    await bot.sendMessage(chatId, [
      "📦 上架命令",
      "",
      "用法:",
      "  listing <1688商品链接> — 提交上架",
      "  listing status <任务ID> — 查询进度",
      "  listing recent — 最近上架记录",
      "",
      "示例: listing https://detail.1688.com/offer/xxx.html",
    ].join("\n"));
    return;
  }

  try {
    const data = await apiClient.submitListing(config, url);
    const taskId = (data as { taskId?: string; id?: string }).taskId || (data as { id?: string }).id || "unknown";
    await bot.sendMessage(chatId, [
      `📦 已提交上架任务`,
      ``,
      `🔗 ${url.slice(0, 80)}...`,
      `🆔 任务ID: \`${taskId}\``,
      ``,
      `查询进度: listing status ${taskId}`,
    ].join("\n"));
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 提交失败: ${(err as Error).message}`);
  }
}

// ---- Auto Select: 关键词 → DeepSeek 搜索1688 → 自动上架全流程 ----

async function handleAutoSelect(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
  keyword: string,
): Promise<void> {
  if (!keyword || keyword.length < 2) {
    await bot.sendMessage(chatId, "⚠️ 用法: 选品 <关键词>\n\n示例: 选品 蓝牙耳机");
    return;
  }

  try {
    await bot.sendMessage(chatId, `🔍 Ops-Agent + Promo-Agent 正在联合选品: "${keyword}"...`);

    // Call centralized Auto-Select API (LangGraph: Ops search → Promo score → cross-validate → auto-list)
    const resp = await fetch(`${config.apiBase}/api/auto-select`, {
      method: "POST",
      headers: { "X-API-Key": config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ keyword }),
      signal: AbortSignal.timeout(45_000),
    });
    const result = await resp.json() as {
      success?: boolean;
      data?: {
        keyword?: string; candidates?: number;
        topProduct?: { title: string; url: string; price: number; finalScore: number; margin: number; verdict: string };
        validationPassed?: boolean; validationIssues?: string[];
        listingTaskId?: string; promoPlanId?: string; report?: string;
      };
    };

    if (!result.success || !result.data) {
      await bot.sendMessage(chatId, `❌ 自动选品失败: ${JSON.stringify(result)}`);
      return;
    }

    const d = result.data;
    const top = d.topProduct;

    if (d.validationPassed && top) {
      await bot.sendMessage(chatId, [
        `✅ **自动选品上架完成**`,
        ``,
        `🛍 商品: ${top.title}`,
        `💰 价格: ¥${top.price}`,
        `📊 评分: ${top.finalScore}/100 (利润率 ${top.margin}%)`,
        `🔗 ${top.url}`,
        ``,
        `📦 上架任务: \`${d.listingTaskId || "已提交"}\``,
        `📢 推广计划: \`${d.promoPlanId || "已创建"}\``,
        ``,
        `🔍 交叉验证: ✅ 通过 (Ops + Promo 双重确认)`,
      ].join("\n"));
    } else if (top) {
      await bot.sendMessage(chatId, [
        `⚠️ **选品完成，但交叉验证未通过 — 未自动上架**`,
        ``,
        `🛍 最佳候选: ${top.title} (¥${top.price}, ${top.finalScore}分)`,
        `🔗 ${top.url}`,
        ``,
        `❌ 验证问题:`,
        ...(d.validationIssues || []).map((i: string) => `  • ${i}`),
        ``,
        `📋 共找到 ${d.candidates || 0} 个候选商品，可手动选择上架`,
      ].join("\n"));
    } else {
      await bot.sendMessage(chatId, `❌ 未找到匹配商品，请尝试其他关键词`);
    }
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 自动选品失败: ${(err as Error).message}`);
  }
}

async function handlePipeline(
  bot: FeishuBot,
  chatId: string,
  config: ApiConfig,
): Promise<void> {
  try {
    const data = await apiClient.pipelineHealth(config);
    const checks = (data.checks as Record<string, unknown>) || {};
    const lines = Object.entries(checks).map(([name, c]) => {
      const st = typeof c === "string" ? c : (c as { status?: string }).status || "unknown";
      const lat = typeof c === "object" ? (c as { latencyMs?: number }).latencyMs : undefined;
      return `${statusEmoji(st === "ok")} ${name}: ${st}${lat ? ` (${lat}ms)` : ""}`;
    });
    await bot.sendMessage(chatId, `🔗 管线检查\n\n${lines.join("\n")}`);
  } catch (err) {
    await bot.sendMessage(chatId, `❌ 检查失败: ${(err as Error).message}`);
  }
}
