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
    key: "DEAD_LETTER_RETRY",
    level: "info",
    label: "死信自动重试",
    template: "死信自动重试完成: {{retried}}条已重置重试, {{failed}}条转永久失败 (本次扫描{{total}}条).",
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
  {
    key: "ORDER_SYNC_FAILED",
    level: "error",
    label: "订单V2同步失败",
    template: "Ozon订单同步异常: {{error}}. 已扫描 {{storeCount}} 个店铺.",
    force: true,
    rateLimit: 3,
  },
  {
    key: "PURCHASE_PAY_SUCCESS",
    level: "info",
    label: "采购支付成功",
    template: "1688采购支付成功: {{postingNumber}} — ¥{{amountCny}} ({{channel}})",
    force: false,
    rateLimit: 50,
  },
  {
    key: "PURCHASE_PAY_FAILED",
    level: "error",
    label: "采购支付失败",
    template: "1688采购支付失败: {{postingNumber}} — {{error}} ({{channel}})",
    force: true,
    rateLimit: 10,
  },
  {
    key: "PURCHASE_RISK_BLOCKED",
    level: "warn",
    label: "采购风控拦截",
    template: "采购风控拦截: {{postingNumber}} — {{reason}}",
    force: true,
    rateLimit: 10,
  },
  {
    key: "ALIBABA_IP_BLOCKED",
    level: "critical",
    label: "1688 IP白名单拦截",
    template: "1688 API IP白名单异常: 渠道={{channel}}, 错误={{error}}. 请将服务器IP加入1688开放平台白名单.",
    force: true,
    rateLimit: 2,
  },
  {
    key: "ALIBABA_AUTH_EXPIRED",
    level: "critical",
    label: "1688 Token过期",
    template: "1688 API认证失效: 渠道={{channel}}, 错误={{error}}. 请更新ALIBABA_ACCESS_TOKEN.",
    force: true,
    rateLimit: 2,
  },
  {
    key: "ALIBABA_BALANCE_LOW",
    level: "critical",
    label: "1688余额不足",
    template: "1688账户余额不足: 渠道={{channel}}, 订单={{postingNumber}}, 错误={{error}}. 请及时充值.",
    force: true,
    rateLimit: 5,
  },
  {
    key: "PURCHASE_QUEUED",
    level: "info",
    label: "采购排队",
    template: "1688采购已排队: {{postingNumber}} — {{reason}}. 延迟60秒后自动执行.",
    force: false,
    rateLimit: 20,
  },
  {
    key: "SUPPLIER_OUT_OF_STOCK",
    level: "critical",
    label: "供应商缺货",
    template: "1688供应商缺货/下架: {{postingNumber}} — 1688链接: {{sourceUrl}}. 采购暂停等待人工处理!",
    force: true,
    rateLimit: 5,
  },
  {
    key: "LOGISTICS_DELAY",
    level: "warn",
    label: "物流延迟预警",
    template: "采购单物流延迟 ⚠️ 超48小时未揽收: {{postingNumber}} ({{hours}}h) — 金额¥{{amountCny}}. 请检查1688物流状态，防止超时罚款！",
    force: true,
    rateLimit: 3,
  },
  {
    key: "LOGISTICS_PICKUP_CONFIRMED",
    level: "info",
    label: "物流已揽收",
    template: "物流已揽收 ✅: {{postingNumber}} — {{trackingNumber}} ({{carrier}}). 已推送货代.",
    force: false,
    rateLimit: 50,
  },
  {
    key: "LOGISTICS_NO_PICKUP",
    level: "critical",
    label: "物流未揽收",
    template: "⚠️ 物流超{{hours}}小时未揽收: {{postingNumber}} (¥{{amountCny}}). 请立即检查!",
    force: true,
    rateLimit: 3,
  },
  {
    key: "LOGISTICS_CUSTOMS_HOLD",
    level: "warn",
    label: "海关滞留",
    template: "海关滞留警告: {{trackingNumber}} ({{carrier}}). 已在海关停留异常长时间.",
    force: true,
    rateLimit: 5,
  },
  {
    key: "LOGISTICS_DELIVERED",
    level: "info",
    label: "物流已签收",
    template: "物流已签收 ✅: {{trackingNumber}} ({{carrier}}) — {{timestamp}}",
    force: false,
    rateLimit: 50,
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
  DEAD_LETTER_RETRY: "DEAD_LETTER_RETRY",
  EXCHANGE_RATE_STALE: "EXCHANGE_RATE_STALE",
  REVIEW_DECLINED: "REVIEW_DECLINED",
  SHIPMENT_FAILED: "SHIPMENT_FAILED",
  ORDER_SYNC_MISMATCH: "ORDER_SYNC_MISMATCH",
  DATA_CONSISTENCY_ALERT: "DATA_CONSISTENCY_ALERT",
  ORDER_SYNC_FAILED: "ORDER_SYNC_FAILED",
  PURCHASE_PAY_SUCCESS: "PURCHASE_PAY_SUCCESS",
  PURCHASE_PAY_FAILED: "PURCHASE_PAY_FAILED",
  PURCHASE_RISK_BLOCKED: "PURCHASE_RISK_BLOCKED",
  ALIBABA_IP_BLOCKED: "ALIBABA_IP_BLOCKED",
  ALIBABA_AUTH_EXPIRED: "ALIBABA_AUTH_EXPIRED",
  ALIBABA_BALANCE_LOW: "ALIBABA_BALANCE_LOW",
  PURCHASE_QUEUED: "PURCHASE_QUEUED",
  SUPPLIER_OUT_OF_STOCK: "SUPPLIER_OUT_OF_STOCK",
  LOGISTICS_DELAY: "LOGISTICS_DELAY",
  LOGISTICS_PICKUP_CONFIRMED: "LOGISTICS_PICKUP_CONFIRMED",
  LOGISTICS_NO_PICKUP: "LOGISTICS_NO_PICKUP",
  LOGISTICS_CUSTOMS_HOLD: "LOGISTICS_CUSTOMS_HOLD",
  LOGISTICS_DELIVERED: "LOGISTICS_DELIVERED",
} as const;

export type EventKey = (typeof EVENT_KEYS)[keyof typeof EVENT_KEYS];
