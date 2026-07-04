// ============================================================
// Unified Notification Service — WeChat Work + Telegram
// Features: retry (3x exponential backoff), rate limiting,
// priority levels, quiet hours, channel health checks
// ============================================================

import { logger } from "@onzo/logger";

// ---- Types ----

export type NotifyLevel = "critical" | "error" | "warn" | "info";
export type NotifyChannel = "wechat" | "telegram";

export interface NotifyPayload {
  level: NotifyLevel;
  event: string;
  message: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
  /** Override quiet hours for critical events */
  force?: boolean;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
  lastSent: number;
}

interface ChannelHealth {
  channel: NotifyChannel;
  available: boolean;
  lastCheck: number;
  lastError?: string;
  successCount: number;
  failCount: number;
}

// ---- Config ----

const WECHAT_WEBHOOK = process.env.NOTIFY_WECHAT_WEBHOOK || "";
const TELEGRAM_BOT = process.env.NOTIFY_TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT = process.env.NOTIFY_TELEGRAM_CHAT_ID || "";

// Quiet hours: only critical events sent during this window (UTC)
const QUIET_START_HOUR = parseInt(process.env.NOTIFY_QUIET_START || "22", 10); // 22:00
const QUIET_END_HOUR = parseInt(process.env.NOTIFY_QUIET_END || "7", 10);     // 07:00

// Rate limit: max N notifications of same event type per window
const RATE_LIMIT_COUNT = parseInt(process.env.NOTIFY_RATE_LIMIT || "10", 10);
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ---- State ----

const rateLimitMap = new Map<string, RateLimitEntry>();
const channelHealth: ChannelHealth[] = [
  { channel: "wechat", available: !!WECHAT_WEBHOOK, lastCheck: 0, successCount: 0, failCount: 0 },
  { channel: "telegram", available: !!(TELEGRAM_BOT && TELEGRAM_CHAT), lastCheck: 0, successCount: 0, failCount: 0 },
];

// ---- Public API ----

export class Notifier {
  /**
   * Send notification to all configured channels.
   * Applies rate limiting, quiet hours, and retry logic automatically.
   */
  async notify(payload: NotifyPayload): Promise<void> {
    const ts = new Date().toISOString();
    logger[payload.level === "error" || payload.level === "critical" ? "error" : "info"](
      { correlationId: payload.correlationId, event: payload.event },
      payload.message
    );

    // Rate limit check
    if (!this.checkRateLimit(payload.event)) {
      logger.debug({ event: payload.event }, "Notification rate-limited — skipped");
      return;
    }

    // Quiet hours check
    if (!this.shouldSendNow(payload.level)) {
      logger.debug({ event: payload.event, level: payload.level }, "Notification suppressed — quiet hours");
      return;
    }

    // Send to all available channels concurrently
    const promises: Promise<void>[] = [];
    if (WECHAT_WEBHOOK) promises.push(this.sendWithRetry("wechat", () => this.sendWechat(payload)));
    if (TELEGRAM_BOT && TELEGRAM_CHAT) promises.push(this.sendWithRetry("telegram", () => this.sendTelegram(payload)));

    await Promise.allSettled(promises);
  }

  /** Convenience: listing failed */
  async listingFailed(correlationId: string, title: string, error: string): Promise<void> {
    await this.notify({ level: "error", event: "LISTING_FAILED", message: `上架失败: ${title} — ${error}`, correlationId, metadata: { title, error } });
  }

  /** Convenience: order created */
  async orderCreated(postingNumber: string, priceRub: number, products: number): Promise<void> {
    await this.notify({ level: "info", event: "ORDER_NEW", message: `新订单 ${postingNumber}: ${products}件, ${priceRub} RUB`, correlationId: postingNumber, metadata: { postingNumber, price: String(priceRub) } });
  }

  /** Convenience: stock alert */
  async stockAlert(sku: number, offerId: string, level: "warn" | "critical"): Promise<void> {
    const event = level === "critical" ? "STOCK_OUT" : "STOCK_LOW";
    await this.notify({ level, event, message: `库存${level === "critical" ? "为零" : "不足"}: SKU ${sku} (${offerId})`, correlationId: `stock-${offerId}-${sku}`, metadata: { sku: String(sku), offerId } });
  }

  /** Get channel health for monitoring */
  getHealth(): ChannelHealth[] {
    return [...channelHealth];
  }

  /** Check if any channel is available */
  get enabled(): boolean {
    return !!(WECHAT_WEBHOOK || (TELEGRAM_BOT && TELEGRAM_CHAT));
  }

  // ---- Private ----

  /** Exponential backoff retry (max 3 attempts) */
  private async sendWithRetry(channel: NotifyChannel, fn: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ok = await fn();
        if (ok) {
          const h = channelHealth.find((c) => c.channel === channel)!;
          h.successCount++;
          h.lastCheck = Date.now();
          h.available = true;
          return;
        }
      } catch (err) {
        const h = channelHealth.find((c) => c.channel === channel)!;
        h.failCount++;
        h.lastError = (err as Error).message;
        logger.warn({ channel, attempt, err: (err as Error).message }, "Notification send failed — retrying");
      }

      if (attempt < 2) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // All retries exhausted — mark channel unhealthy
    const h = channelHealth.find((c) => c.channel === channel)!;
    h.available = false;
    logger.error({ channel }, "Notification channel marked UNHEALTHY after 3 failures");
  }

  /** Check if notification should be rate-limited */
  private checkRateLimit(eventKey: string): boolean {
    const now = Date.now();
    let entry = rateLimitMap.get(eventKey);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.set(eventKey, { count: 1, windowStart: now, lastSent: now });
      return true;
    }

    if (entry.count >= RATE_LIMIT_COUNT) return false;
    entry.count++;
    entry.lastSent = now;
    return true;
  }

  /** Check quiet hours — only critical events bypass */
  private shouldSendNow(level: NotifyLevel): boolean {
    if (level === "critical") return true; // Critical always sends
    const hour = new Date().getUTCHours();
    if (QUIET_START_HOUR < QUIET_END_HOUR) {
      return hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR;
    }
    // Overnight range (e.g., 22:00 - 07:00)
    return hour < QUIET_START_HOUR && hour >= QUIET_END_HOUR;
  }

  // ---- Channel senders ----

  private async sendWechat(payload: NotifyPayload): Promise<boolean> {
    const emoji = payload.level === "critical" ? "🔴" : payload.level === "error" ? "🟠" : payload.level === "warn" ? "🟡" : "🟢";
    const content = [
      `## ${emoji} ONZO ${payload.event}`,
      `> ${payload.message}`,
      ``,
      `- 级别: ${payload.level}`,
      `- 时间: ${new Date().toLocaleString("zh-CN")}`,
      `- ID: \`${payload.correlationId}\``,
    ].join("\n");

    const resp = await fetch(WECHAT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await resp.json() as { errcode?: number };
    if (!resp.ok || (data.errcode && data.errcode !== 0)) {
      logger.warn({ errcode: data.errcode }, "WeChat webhook failed");
      return false;
    }
    return true;
  }

  private async sendTelegram(payload: NotifyPayload): Promise<boolean> {
    const emoji = payload.level === "critical" ? "🔴" : payload.level === "error" ? "🟠" : payload.level === "warn" ? "🟡" : "🟢";
    let text = `<b>${emoji} ONZO ${payload.event}</b>\n<i>${payload.message}</i>\n\n`;
    text += `<b>级别:</b> ${payload.level}\n<b>时间:</b> ${new Date().toLocaleString("zh-CN")}\n<b>ID:</b> <code>${payload.correlationId}</code>`;

    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await resp.json() as { ok?: boolean };
    if (!resp.ok || !data.ok) {
      logger.warn({ response: data }, "Telegram send failed");
      return false;
    }
    return true;
  }
}

// Singleton
export const notifier = new Notifier();
