// ============================================================
// Notification Service — Phase 1: Console log + DB record
// Phase 2: WeChat Work / Telegram / Email webhooks
// ============================================================

import { saveListingRecord } from "../db/models.js";

export interface NotifyPayload {
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

export class Notifier {
  private webhookUrls: { wechat?: string; telegram?: string; email?: string };

  constructor(webhooks?: { wechat?: string; telegram?: string; email?: string }) {
    this.webhookUrls = webhooks ?? {};
  }

  /**
   * Send a notification.
   * Phase 1: console + DB only.
   * Phase 2: Dispatch to configured webhooks.
   */
  async notify(payload: NotifyPayload): Promise<void> {
    const ts = new Date().toISOString();
    const logFn = payload.level === "error" ? console.error : payload.level === "warn" ? console.warn : console.log;

    logFn(`[${payload.level.toUpperCase()}] [${payload.correlationId}] ${payload.event}: ${payload.message}`);

    // Record to listing_records as an event log
    await saveListingRecord({
      id: crypto.randomUUID(),
      sourceUrl: `event:${payload.event}`,
      status: payload.level === "error" ? "failed" : payload.level === "warn" ? "pending_retry" : "done",
      correlationId: payload.correlationId,
      resultJson: JSON.stringify({ event: payload.event, message: payload.message, metadata: payload.metadata, timestamp: ts }),
    }).catch(() => {});

    // Phase 2: dispatch to webhooks
    if (this.webhookUrls.wechat) {
      fetch(this.webhookUrls.wechat, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: `[ONZO] ${payload.event}: ${payload.message}` } }),
      }).catch(() => {});
    }
  }

  /** Shorthand for pipeline success notification */
  async notifySuccess(correlationId: string, title: string, draftId: string): Promise<void> {
    await this.notify({ level: "info", event: "listing_created", message: `Draft ${draftId}: ${title}`, correlationId, metadata: { draftId, title } });
  }

  /** Shorthand for pipeline failure notification */
  async notifyFailure(correlationId: string, step: string, error: string): Promise<void> {
    await this.notify({ level: "error", event: "pipeline_failed", message: `[${step}] ${error}`, correlationId, metadata: { step, error } });
  }
}
