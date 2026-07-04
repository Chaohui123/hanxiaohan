// ============================================================
// Prometheus Metrics — real prom-client implementation
// HTTP: request_count, request_duration_seconds
// Business: listing, order, token, queue, scraper, fx
// Exposed at GET /metrics
// ============================================================

import { Counter, Histogram, Gauge, register } from "prom-client";

// ---- HTTP Metrics ----
export const requestCounter = new Counter({
  name: "onzo_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "path", "status_code"] as const,
});

export const requestDuration = new Histogram({
  name: "onzo_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "path"] as const,
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
});

// ---- Business Metrics ----
export const listingPipelineTotal = new Counter({
  name: "onzo_listing_pipeline_total",
  help: "Total listing pipeline executions",
  labelNames: ["status"] as const,
});

export const listingPipelineDuration = new Histogram({
  name: "onzo_listing_pipeline_duration_seconds",
  help: "Listing pipeline duration in seconds",
  labelNames: ["step"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300],
});

export const orderSyncTotal = new Counter({
  name: "onzo_order_sync_total",
  help: "Total orders synced from Ozon",
  labelNames: ["type"] as const,
});

export const orderSyncDuration = new Histogram({
  name: "onzo_order_sync_duration_seconds",
  help: "Order sync duration",
  buckets: [1, 5, 10, 30, 60, 120],
});

export const tokenUsageTotal = new Counter({
  name: "onzo_token_usage_total",
  help: "Total LLM tokens consumed",
  labelNames: ["provider", "model"] as const,
});

export const taskQueueSize = new Gauge({
  name: "onzo_task_queue_size",
  help: "Task queue size by status",
  labelNames: ["status"] as const,
});

export const activeWorkers = new Gauge({
  name: "onzo_active_workers",
  help: "Number of active worker threads",
});

export const scraperRequestsTotal = new Counter({
  name: "onzo_scraper_requests_total",
  help: "Total scraper requests",
  labelNames: ["result"] as const,
});

export const exchangeRateValue = new Gauge({
  name: "onzo_exchange_rate",
  help: "Current CNY→RUB exchange rate",
});

export const errorCounter = new Counter({
  name: "onzo_errors_total",
  help: "Total errors by type",
  labelNames: ["code", "step"] as const,
});

export const circuitBreakerState = new Gauge({
  name: "onzo_circuit_breaker_state",
  help: "Circuit breaker state: 0=CLOSED, 1=OPEN, 2=HALF_OPEN",
  labelNames: ["name"] as const,
});

export const webhookEventsTotal = new Counter({
  name: "onzo_webhook_events_total",
  help: "Total webhook events received",
  labelNames: ["event_type", "result"] as const,
});

export const deadLetterQueueSize = new Gauge({
  name: "onzo_dead_letter_queue_size",
  help: "Number of items in dead letter queue",
});

// ---- Collect & Export ----
export async function collectMetrics(): Promise<string> {
  return register.metrics();
}

export function getMetrics() {
  return [
    requestCounter, requestDuration,
    listingPipelineTotal, listingPipelineDuration,
    orderSyncTotal, tokenUsageTotal,
    taskQueueSize, activeWorkers,
    scraperRequestsTotal, exchangeRateValue,
    errorCounter, circuitBreakerState,
    webhookEventsTotal, deadLetterQueueSize,
  ];
}
