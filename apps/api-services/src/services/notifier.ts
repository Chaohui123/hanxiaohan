// ============================================================
// Notification Service — WeChat Work / Telegram / Email
// ============================================================

export interface NotifyPayload {
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

interface WebhookSendResult {
  channel: string;
  success: boolean;
  error?: string;
}

/**
 * Format message for WeChat Work Bot (Markdown).
 * WeChat Work bot limits: max 4096 chars for markdown content.
 */
function formatWechatMarkdown(payload: NotifyPayload): string {
  const emoji = payload.level === "error" ? "🔴" : payload.level === "warn" ? "🟡" : "🟢";
  const lines = [
    `## ${emoji} ONZO ${payload.event}`,
    `> ${payload.message}`,
    ``,
    `- **级别**: ${payload.level}`,
    `- **时间**: ${new Date().toLocaleString("zh-CN")}`,
    `- **CorrelationID**: \`${payload.correlationId}\``,
  ];

  if (payload.metadata) {
    lines.push("");
    for (const [k, v] of Object.entries(payload.metadata)) {
      lines.push(`- **${k}**: ${v}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format message for Telegram Bot (HTML).
 */
function formatTelegramHtml(payload: NotifyPayload): string {
  const emoji = payload.level === "error" ? "🔴" : payload.level === "warn" ? "🟡" : "🟢";
  let text = `<b>${emoji} ONZO ${payload.event}</b>\n`;
  text += `<i>${payload.message}</i>\n\n`;
  text += `<b>级别:</b> ${payload.level}\n`;
  text += `<b>时间:</b> ${new Date().toLocaleString("zh-CN")}\n`;
  text += `<b>CorrelationID:</b> <code>${payload.correlationId}</code>`;

  if (payload.metadata) {
    text += "\n";
    for (const [k, v] of Object.entries(payload.metadata)) {
      text += `\n<b>${k}:</b> ${v}`;
    }
  }

  return text;
}

/**
 * Send to WeChat Work Bot webhook.
 * Documentation: https://developer.work.weixin.qq.com/document/path/91770
 */
async function sendWechat(webhookUrl: string, payload: NotifyPayload): Promise<WebhookSendResult> {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content: formatWechatMarkdown(payload) },
      }),
    });

    const data = await resp.json() as { errcode?: number };
    if (!resp.ok || (data.errcode && data.errcode !== 0)) {
      return { channel: "wechat", success: false, error: `errcode=${data.errcode}` };
    }
    return { channel: "wechat", success: true };
  } catch (err) {
    return { channel: "wechat", success: false, error: (err as Error).message };
  }
}

/**
 * Send to Telegram Bot API.
 * Documentation: https://core.telegram.org/bots/api#sendmessage
 */
async function sendTelegram(botToken: string, chatId: string, payload: NotifyPayload): Promise<WebhookSendResult> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatTelegramHtml(payload),
        parse_mode: "HTML",
      }),
    });

    const data = await resp.json() as { ok?: boolean };
    if (!resp.ok || !data.ok) {
      return { channel: "telegram", success: false, error: JSON.stringify(data) };
    }
    return { channel: "telegram", success: true };
  } catch (err) {
    return { channel: "telegram", success: false, error: (err as Error).message };
  }
}

export class Notifier {
  private wechatWebhook: string;
  private telegramBotToken: string;
  private telegramChatId: string;

  constructor() {
    this.wechatWebhook = process.env.NOTIFY_WECHAT_WEBHOOK || "";
    this.telegramBotToken = process.env.NOTIFY_TELEGRAM_BOT_TOKEN || "";
    this.telegramChatId = process.env.NOTIFY_TELEGRAM_CHAT_ID || "";
  }

  get enabled(): boolean {
    return !!(this.wechatWebhook || (this.telegramBotToken && this.telegramChatId));
  }

  /**
   * Send notification to all configured channels.
   * Phase 1: console log always; webhooks if configured.
   */
  async notify(payload: NotifyPayload): Promise<WebhookSendResult[]> {
    const ts = new Date().toISOString();
    const logFn = payload.level === "error" ? console.error
      : payload.level === "warn" ? console.warn
      : console.log;

    logFn(`[${payload.level.toUpperCase()}] [${payload.correlationId}] ${payload.event}: ${payload.message}`);

    const results: WebhookSendResult[] = [];

    // Fire webhooks concurrently (fire-and-forget per channel)
    const promises: Promise<WebhookSendResult>[] = [];

    if (this.wechatWebhook) {
      promises.push(sendWechat(this.wechatWebhook, payload));
    }
    if (this.telegramBotToken && this.telegramChatId) {
      promises.push(sendTelegram(this.telegramBotToken, this.telegramChatId, payload));
    }

    if (promises.length > 0) {
      const settled = await Promise.allSettled(promises);
      for (const r of settled) {
        if (r.status === "fulfilled") {
          results.push(r.value);
          if (!r.value.success) {
            console.warn(`[Notifier] ${r.value.channel} send failed: ${r.value.error}`);
          }
        }
      }
    }

    return results;
  }

  /** Shorthand for pipeline success */
  async notifySuccess(correlationId: string, title: string, draftId: string, productId?: number): Promise<void> {
    await this.notify({
      level: "info",
      event: "上架成功",
      message: `商品 "${title}" 已创建草稿`,
      correlationId,
      metadata: { draftId, productId: String(productId ?? ""), title },
    });
  }

  /** Shorthand for pipeline failure */
  async notifyFailure(correlationId: string, step: string, error: string, url?: string): Promise<void> {
    await this.notify({
      level: "error",
      event: "上架失败",
      message: `[${step}] ${error}`,
      correlationId,
      metadata: { step, error, url: url ?? "" },
    });
  }
}

// Singleton
export const notifier = new Notifier();
