// ============================================================
// Notification Event Registry — unified event definitions
// All notification events MUST be registered here.
// ============================================================

import { notifier, type NotifyLevel } from "./notifier.js";

// ---- Event Definition ----

export interface NotificationEvent {
  /** Unique event key (e.g., "LISTING_FAILED") */
  key: string;
  /** Default priority level */
  level: NotifyLevel;
  /** Human-readable event name (Chinese) */
  label: string;
  /** Message template: use {{key}} for variable substitution */
  template: string;
  /** Whether this event should bypass quiet hours (critical events) */
  force: boolean;
  /** Rate limit: max occurrences per 5-minute window (0 = no limit) */
  rateLimit: number;
}

// ---- Event Registry ----

export const NOTIFICATION_EVENTS: NotificationEvent[] = [
  {
    key: "LISTING_FAILED",
    level: "error",
    label: "上架失败",
    template: "商品上架失败: {{title}} — {{error}}",
    force: false,
    rateLimit: 20,
  },
  {
    key: "LISTING_SUCCESS",
    level: "info",
    label: "上架成功",
    template: "商品上架成功: {{title}} ({{draftId}})",
    force: false,
    rateLimit: 50,
  },
  {
    key: "ORDER_NEW",
    level: "info",
    label: "新订单",
    template: "新订单 {{postingNumber}}: {{productCount}}件, {{priceRub}} RUB",
    force: false,
    rateLimit: 100,
  },
  {
    key: "ORDER_CANCELLED",
    level: "warn",
    label: "订单取消",
    template: "订单 {{postingNumber}} 已取消 — 库存已恢复",
    force: false,
    rateLimit: 30,
  },
  {
    key: "ORDER_SHIPPED",
    level: "info",
    label: "订单发货",
    template: "订单 {{postingNumber}} 已发货 — {{trackingNumber}}",
    force: false,
    rateLimit: 100,
  },
  {
    key: "STOCK_LOW",
    level: "warn",
    label: "库存不足",
    template: "SKU {{sku}} ({{offerId}}) 库存不足: {{currentStock}}件剩余",
    force: false,
    rateLimit: 10,
  },
  {
    key: "STOCK_OUT",
    level: "critical",
    label: "库存为零",
    template: "SKU {{sku}} ({{offerId}}) 库存归零 — 请立即补货!",
    force: true,
    rateLimit: 5,
  },
  {
    key: "PRICE_ANOMALY",
    level: "warn",
    label: "价格异常",
    template: "价格异常: {{product}} — 当前 {{currentPrice}} RUB, 预期 {{expectedPrice}} RUB",
    force: false,
    rateLimit: 10,
  },
  {
    key: "SCRAPER_BLOCKED",
    level: "critical",
    label: "爬虫被封",
    template: "1688爬虫触发验证码 — 冷却 {{cooldownMinutes}}分钟. URL: {{url}}",
    force: true,
    rateLimit: 3,
  },
  {
    key: "CIRCUIT_BREAKER_OPEN",
    level: "warn",
    label: "熔断器打开",
    template: "{{service}} 熔断器已打开 (连续失败 {{failures}}次) — 30秒后半开探测",
    force: false,
    rateLimit: 5,
  },
  {
    key: "TOKEN_LIMIT_REACHED",
    level: "critical",
    label: "Token超限",
    template: "LLM Token用量达上限: {{used}}/{{limit}} ({{percent}}%). 今日所有AI调用已暂停.",
    force: true,
    rateLimit: 3,
  },
  {
    key: "DEAD_LETTER_FULL",
    level: "warn",
    label: "死信积压",
    template: "死信队列积压: {{count}}条待处理. 类型: {{category}}.",
    force: false,
    rateLimit: 5,
  },
  {
    key: "EXCHANGE_RATE_STALE",
    level: "warn",
    label: "汇率过期",
    template: "汇率缓存已过期 ({{hoursStale}}小时). 当前汇率 {{rate}}, 来源 {{source}}.",
    force: false,
    rateLimit: 3,
  },
  {
    key: "REVIEW_DECLINED",
    level: "warn",
    label: "审核被拒",
    template: "Ozon审核被拒: {{productId}} — {{count}}个商品.",
    force: false,
    rateLimit: 10,
  },
  {
    key: "SHIPMENT_FAILED",
    level: "error",
    label: "发货失败",
    template: "订单 {{postingNumber}} 发货失败: {{error}}",
    force: false,
    rateLimit: 20,
  },
  {
    key: "ORDER_SYNC_MISMATCH",
    level: "warn",
    label: "订单数据不一致",
    template: "订单数量差异 {{deviationPct}}%: 本地 {{localCount}} vs Ozon {{ozonCount}}. 最近24h可能漏单.",
    force: false,
    rateLimit: 3,
  },
  {
    key: "DATA_CONSISTENCY_ALERT",
    level: "warn",
    label: "数据一致性告警",
    template: "{{check}}: {{detail}}",
    force: false,
    rateLimit: 5,
  },
];

// ---- Event Emitter ----

/**
 * Emit a notification event by key with variable substitution.
 */
export async function emitEvent(
  eventKey: string,
  vars: Record<string, string>,
  correlationId?: string
): Promise<void> {
  const def = NOTIFICATION_EVENTS.find((e) => e.key === eventKey);
  if (!def) {
    // Unknown event — send as generic info
    await notifier.notify({
      level: "info",
      event: eventKey,
      message: JSON.stringify(vars),
      correlationId: correlationId || `event-${eventKey}`,
    });
    return;
  }

  let message = def.template;
  for (const [key, value] of Object.entries(vars)) {
    message = message.replace(`{{${key}}}`, value);
  }

  await notifier.notify({
    level: def.level,
    event: def.label,
    message,
    correlationId: correlationId || `event-${eventKey}-${Date.now()}`,
    force: def.force,
    metadata: vars,
  });
}

// ---- Event Map (for programmatic access) ----
export const EVENT_KEYS = {
  LISTING_FAILED: "LISTING_FAILED",
  LISTING_SUCCESS: "LISTING_SUCCESS",
  ORDER_NEW: "ORDER_NEW",
  ORDER_CANCELLED: "ORDER_CANCELLED",
  ORDER_SHIPPED: "ORDER_SHIPPED",
  STOCK_LOW: "STOCK_LOW",
  STOCK_OUT: "STOCK_OUT",
  PRICE_ANOMALY: "PRICE_ANOMALY",
  SCRAPER_BLOCKED: "SCRAPER_BLOCKED",
  CIRCUIT_BREAKER_OPEN: "CIRCUIT_BREAKER_OPEN",
  TOKEN_LIMIT_REACHED: "TOKEN_LIMIT_REACHED",
  DEAD_LETTER_FULL: "DEAD_LETTER_FULL",
  EXCHANGE_RATE_STALE: "EXCHANGE_RATE_STALE",
  REVIEW_DECLINED: "REVIEW_DECLINED",
  SHIPMENT_FAILED: "SHIPMENT_FAILED",
  ORDER_SYNC_MISMATCH: "ORDER_SYNC_MISMATCH",
  DATA_CONSISTENCY_ALERT: "DATA_CONSISTENCY_ALERT",
} as const;

export type EventKey = (typeof EVENT_KEYS)[keyof typeof EVENT_KEYS];
