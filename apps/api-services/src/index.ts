import express from "express";
import cors from "cors";
import helmet from "helmet";
import { loadConfig } from "./config.js";
import { validateProductionConfig } from "./config-validation.js";
import { registerJob, startScheduler, stopScheduler } from "./services/scheduler.js";
import { correlationIdMiddleware } from "./middleware/correlation-id.js";
import { accessLogMiddleware } from "./middleware/access-log.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createLogger } from "./middleware/logger.js";
import { createHealthRouter } from "./routes/health.route.js";
import { createProcessRouter } from "./routes/process.route.js";
import { createStatsRouter } from "./routes/stats.route.js";
import { createBackupRouter, startAutoBackup, stopAutoBackup } from "./routes/backup.route.js";
import { createOrderRouter } from "./routes/order.route.js";
import { createWebhookRouter } from "./routes/webhook.route.js";
import { createBulkRouter } from "./routes/bulk.route.js";
import { createDashboardRouter } from "./routes/dashboard.route.js";
import { createPriceRouter } from "./routes/price.route.js";
import { createStoreRouter } from "./routes/store.route.js";
import { createStoreAdminRouter } from "./routes/store-admin.route.js";
import { createDashboardHtmlRouter } from "./routes/dashboard-html.route.js";
import { CosUploader } from './services/cos-uploader.js';
import { createAnalyzeRouter } from "./routes/analyze.route.js";
import { createInventoryRouter } from "./routes/inventory.route.js";
import { createAftersalesRouter } from "./routes/aftersales.route.js";
import { createAlertRouter } from "./routes/alert.route.js";
import { createPromoRouter } from "./routes/promo.route.js";
import { createRagRouter } from "./routes/rag.route.js";
import { ragRateLimit } from "./middleware/rag-rate-limit.js";
import { RagIndexer } from "./services/rag-indexer.js";
import { createDiagnoseRouter } from "./routes/diagnose.route.js";
import { createOpsRouter } from "./routes/ops.route.js";
import { startLogisticsPolling, stopLogisticsPolling } from "./services/logistics-polling.js";
import { runSmokeTests } from "./startup-smoke-test.js";
import { timeoutMiddleware } from "./middleware/timeout.js";
import { idempotencyMiddleware } from "./middleware/idempotency.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { registerCleanup, setupShutdownHandlers } from "./middleware/shutdown.js";
import { mockMiddleware } from "./routes/mock.middleware.js";
import { auditMiddleware } from "./middleware/audit.js";
import { requestTimingMiddleware } from "./middleware/request-timing.js";
import { swaggerSpec } from "./swagger.js";
import { getDb } from "./db/connection.js";
// OTEL tracing — lazy dynamic import to avoid startup crash when OTEL packages are incompatible
let initTracing = async (_name: string) => {};
let shutdownTracing = async () => {};
async function loadTracing() {
  try {
    const mod = await import("./tracing/index.js");
    initTracing = mod.initTracing;
    shutdownTracing = mod.shutdownTracing;
  } catch { /* OTEL unavailable — tracing disabled */ }
}
import { collectMetrics, requestCounter, requestDuration, refreshPoolMetrics } from "./metrics/index.js";

let swaggerUi: { serve: express.RequestHandler; setup: (spec: unknown) => express.RequestHandler } | null = null;
async function loadSwagger() {
  try { swaggerUi = (await import("swagger-ui-express")).default as unknown as typeof swaggerUi; } catch { }
}

const config = loadConfig();
validateProductionConfig();
const logger = createLogger(config);

// Optional OpenTelemetry tracing (no-op unless OTEL_ENABLED=true)
await loadTracing();
initTracing("onzo-api-services").catch(() => {});

const app: express.Express = express();

const isProduction = (process.env.ENV || process.env.NODE_ENV) === "production";
const corsFallback = isProduction ? "" : "http://localhost:3000,http://localhost:5173,http://localhost:5678";
const allowedOrigins = (process.env.CORS_ORIGINS || corsFallback)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : undefined,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "X-Correlation-ID"],
  exposedHeaders: ["X-Correlation-ID", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
  maxAge: 86400,
}));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "same-origin" },
  originAgentCluster: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  },
}));

app.use(timeoutMiddleware(120_000));
app.use(correlationIdMiddleware);
app.use(accessLogMiddleware);
app.use(rateLimitMiddleware);
// Ozon API rate limiter (Redis counter-based, prevents 429 errors)
const { ozonRateLimiter } = await import("./middleware/ozon-rate-limiter.js");
app.use(ozonRateLimiter);
app.use(idempotencyMiddleware);
app.use(authMiddleware);
app.use(auditMiddleware);
app.use(requestTimingMiddleware);
app.use(mockMiddleware);

// ---- API Versioning ----
// All API routes are mounted under /api/v1 (current) and /api (deprecated, to be removed in v2).
// Clients should migrate to /api/v1. Old /api paths receive a deprecation header.

const API_V1 = "/api/v1";

/** Mount a router at both /api and /api/v1, with deprecation header on /api paths. */
function mountApi(
  path: string,
  ...handlers: (express.RequestHandler | express.Router)[]
): void {
  // v1 (current)
  app.use(`${API_V1}${path}`, ...handlers);
  // Legacy path with deprecation notice
  app.use(`/api${path}`, (req, res, next) => {
    res.setHeader("X-API-Deprecated", "true");
    res.setHeader("X-API-Deprecation-Date", "2026-10-01");
    res.setHeader("Sunset", "2027-04-01");
    next();
  }, ...handlers);
}

// Serve downloaded images for Ozon URL import (Ozon has no local-file upload API)
import { mkdirSync, existsSync } from "node:fs";
const tmpImgDir = "./data/tmp-images";
if (!existsSync(tmpImgDir)) mkdirSync(tmpImgDir, { recursive: true });
app.use("/tmp-images", express.static(tmpImgDir, { maxAge: 300_000 }));

// Webhook: mounted at /api directly (without mountApi deprecation middleware)
// Must be before other mountApi calls to avoid deprecation headers on Ozon requests
app.use("/api", createWebhookRouter());

mountApi("", createStatsRouter());
mountApi("", createBackupRouter());
// Webhook: mounted directly (no mountApi) to avoid deprecation headers interfering with Ozon
app.use("/api", createWebhookRouter());
app.use("/api/v1", createWebhookRouter());
mountApi("", createPriceRouter());
mountApi("", createStoreRouter());
mountApi("", createStoreAdminRouter());

app.use(createDashboardHtmlRouter());

await loadSwagger();
if (swaggerUi) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ui = swaggerUi as any;
  app.use("/api/docs", ui.serve, ui.setup(swaggerSpec));
}

app.get("/metrics", async (_req, res) => {
  try {
    // Refresh pool stats before serving metrics
    const { getPoolStats } = await import("./db/connection.js");
    refreshPoolMetrics(getPoolStats());

    const poolStats = getPoolStats();
    if (poolStats.waiting > 10) {
      logger.warn({ poolStats }, "DB connection pool exhausted — waiting count > 10");
      const { emitEvent } = await import("./services/notification-events.js");
      emitEvent("CIRCUIT_BREAKER_OPEN", {
        service: "db-pool",
        failures: String(poolStats.waiting),
      }).catch(() => {});
    }

    const metrics = await collectMetrics();
    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(metrics);
  } catch (err) {
    res.status(500).send("Failed to collect metrics");
  }
});

const db = await getDb().catch((err) => {
  logger.warn({ err }, "DB not available 鈥?running without persistence");
  return null;
});

if (db) {
  startAutoBackup();
  registerCleanup(async () => { stopAutoBackup(); });
  registerCleanup(async () => { const { closeDb } = await import("./db/connection.js"); await closeDb(); });
}

// Register built-in scheduled jobs (replaces n8n for critical periodic tasks)
// n8n remains available as a backup option — these don't duplicate when n8n calls the same API endpoints

registerJob("order-sync", 30 * 60_000, async () => {
  const { syncOrders } = await import("@onzo/ozon-order");
  await syncOrders(ozonClient, { storeId: "store_1", pageSize: 50 }).catch((err) =>
    logger.error({ err }, "Scheduled order sync failed")
  );
});

registerJob("auto-ship", 3 * 3600_000, async () => {
  const { batchShipOrders } = await import("./services/auto-ship.js");
  await batchShipOrders(ozonClient).catch((err) =>
    logger.error({ err }, "Scheduled auto-ship failed")
  );
});

registerJob("review-sync", 3600_000, async () => {
  const { syncReviewStatuses } = await import("./services/review-sync.js");
  await syncReviewStatuses(ozonClient).catch((err) =>
    logger.error({ err }, "Scheduled review sync failed")
  );
});

registerJob("exchange-rate-refresh", 3600_000, async () => {
  const { forceRefreshRate } = await import("./services/exchange-rate.js");
  forceRefreshRate();
});

registerJob("market-data-collect", 24 * 3600_000, async () => {
  const { collectMarketData } = await import("./services/market-data-collector.js");
  await collectMarketData([], ozonClient).catch((err) =>
    logger.error({ err }, "Scheduled market data collection failed")
  );
});

registerJob("token-monitor", 6 * 3600_000, async () => {
  const used = tokenTracker.getTodayUsage();
  const limit = parseInt(process.env.LLM_DAILY_TOKEN_LIMIT || "0", 10);
  const remainingPercent = limit > 0 ? Math.round((1 - used / limit) * 100) : 100;

  logger.info({
    usedTokens: used,
    dailyLimit: limit,
    remainingPercent,
  }, "LLM token usage report");

  if (limit > 0 && used >= limit) {
    const { emitEvent } = await import("./services/notification-events.js");
    await emitEvent("TOKEN_LIMIT_REACHED", {
      used: String(used),
      limit: String(limit),
      percent: String(Math.round((used / limit) * 100)),
    });
  } else if (limit > 0 && used >= limit * 0.9) {
    logger.warn({
      usedTokens: used,
      dailyLimit: limit,
      remaining: limit - used,
    }, "LLM token limit approaching — reduce AI usage or increase LLM_DAILY_TOKEN_LIMIT");
  }
});

registerJob("data-consistency-check", 6 * 3600_000, async () => {
  const { getDb } = await import("./db/connection.js");
  const db = await getDb().catch(() => null);
  const { emitEvent } = await import("./services/notification-events.js");

  // 1. Order count mismatch — local vs Ozon (last 24h)
  try {
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
    const localRows = (await db?.all(
      "SELECT COUNT(*) as cnt FROM local_orders WHERE created_at >= ?",
      [yesterday]
    ).catch(() => [])) as Array<{ cnt: number }>;
    const localCount: number = localRows?.[0]?.cnt ?? -1;

    // Fetch Ozon posting count via FBO list
    let ozonCount: number = -1;
    try {
      const ozonResp = await ozonClient.request<{ result: { count?: number } }>(
        "POST", "/v3/posting/fbo/list",
        { filter: { since: yesterday }, limit: 1, offset: 0 }
      );
      ozonCount = (ozonResp.result as { count?: number } | undefined)?.count ?? -1;
    } catch { /* Ozon API unavailable */ }

    if (localCount >= 0 && ozonCount >= 0) {
      const diff = Math.abs(localCount - ozonCount);
      const deviationPct = ozonCount > 0 ? Math.round((diff / ozonCount) * 100) : 0;
      if (deviationPct > 5) {
        logger.warn({ localCount, ozonCount, deviationPct }, "Order count mismatch detected");
        await emitEvent("ORDER_SYNC_MISMATCH", {
          deviationPct: String(deviationPct),
          localCount: String(localCount),
          ozonCount: String(ozonCount),
        });
      } else {
        logger.info({ localCount, ozonCount, deviationPct }, "Order counts consistent");
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Order consistency check failed");
  }

  // 2. Inventory stock sync difference
  try {
    const invRows = await db?.all(
      "SELECT offer_id, sku, stock_available FROM inventory WHERE stock_available > 0 LIMIT 100"
    ).catch(() => [] as Array<{ offer_id: string; sku: number; stock_available: number }>);
    if (invRows && invRows.length > 0) {
      try {
        const stocksResp = await ozonClient.request<{ result: { items?: Array<{ offer_id: string; sku: number; stock: number }> } }>(
          "POST", "/v3/product/info/stocks",
          { filter: { offer_id: invRows.map((r) => r.offer_id) } }
        );
        const ozonStocks = new Map<string, number>();
        for (const item of stocksResp.result?.items || []) {
          ozonStocks.set(`${item.offer_id}:${item.sku}`, item.stock);
        }
        const diffs: string[] = [];
        for (const r of invRows) {
          const ozonStock = ozonStocks.get(`${r.offer_id}:${r.sku}`);
          if (ozonStock !== undefined && ozonStock !== r.stock_available) {
            diffs.push(`${r.offer_id}:${r.sku} local=${r.stock_available} ozon=${ozonStock}`);
          }
        }
        if (diffs.length > 0) {
          logger.warn({ diffCount: diffs.length, diffs: diffs.slice(0, 20) }, "Inventory stock mismatch");
        }
      } catch { /* Ozon stocks API unavailable */ }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Inventory consistency check failed");
  }

  // 3. Dead letter queue backlog
  try {
    const { readdir } = await import("node:fs/promises");
    const dlDir = process.env.DEAD_LETTER_DIR || "./dead-letter";
    const files = await readdir(dlDir).catch(() => [] as string[]);
    if (files.length > 20) {
      await emitEvent("DEAD_LETTER_FULL", {
        count: String(files.length),
        category: "consistency-check",
      });
    }
  } catch { /* dead-letter dir not accessible */ }
});

registerJob("finance-reconcile", 24 * 3600_000, async () => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3600_000);
  const dateFrom = yesterday.toISOString().slice(0, 10);
  const dateTo = now.toISOString().slice(0, 10);

  const { reconcileFinance } = await import("./services/finance-reconciler.js");
  const result = await reconcileFinance(ozonClient, dateFrom, dateTo);

  logger.info({
    job: "finance-reconcile",
    dateFrom,
    dateTo,
    totalOrders: result.totalOrders,
    matched: result.matched,
    discrepancies: result.discrepancies.length,
    missingLocal: result.missingLocal,
    missingOzon: result.missingOzon,
  }, "Daily finance reconciliation complete");

  if (result.discrepancies.length > 0) {
    logger.warn({
      discrepancies: result.discrepancies.slice(0, 10),
    }, "Finance discrepancies detected — review required");
  }
});

// Ozon Order Sync v2 — every 5 minutes, with Redis distributed lock
registerJob("ozon-order-sync-v2", 5 * 60_000, async () => {
  if (!db) { logger.warn("OzonOrderSync: DB unavailable, skipping cycle"); return; }
  const { OzonOrderSyncService } = await import("./services/ozon-order-sync.js");
  const { acquireLock, releaseLock } = await import("./services/redis-lock.js");
  const lockToken = await acquireLock("global", 300);
  if (!lockToken) { logger.info("OzonOrderSync: Global lock held by another instance, skipping"); return; }
  try {
    const service = new OzonOrderSyncService(db);
    const result = await service.syncAllStores();
    logger.info({ ...result }, "OzonOrderSync: Scheduled sync completed");
    if (result.errors.length > 0) {
      const { emitEvent } = await import("./services/notification-events.js");
      await emitEvent("ORDER_SYNC_FAILED", {
        error: result.errors.slice(0, 3).join("; "),
        storeCount: String(result.storesScanned),
      });
    }
  } finally {
    await releaseLock("global", lockToken);
  }
});

startScheduler();

// ---- RAG incremental indexing (hourly) ----
const ragIndexer = new RagIndexer();
const RAG_INDEX_INTERVAL = parseInt(process.env.RAG_INDEX_INTERVAL_MINUTES || "60", 10);
setInterval(async () => {
  try {
    const result = await ragIndexer.reindexAll();
    if (Object.values(result).some((v) => v > 0)) {
      logger.info({ result }, "RAG incremental index completed");
    }
  } catch (err) {
    logger.error({ err }, "RAG indexing failed");
  }
}, RAG_INDEX_INTERVAL * 60 * 1000);
logger.info({ intervalMin: RAG_INDEX_INTERVAL }, "RAG indexer scheduled");
registerCleanup(async () => { await stopScheduler(); });

const { TaskQueue } = await import("./db/task-queue.js");
const taskQueue = new TaskQueue(db ?? undefined, config.maxTaskConcurrency);
await taskQueue.init();
logger.info({ stats: taskQueue.getStats() }, "Task queue initialized");

// Register webhook retry handler — re-processes failed webhook events
taskQueue.registerHandler("webhook_retry", async (task) => {
  try {
    const data = task.payload as { eventType?: string; body?: Record<string, unknown> } || {};
    const body = data.body || {};
    const { handleWebhookEvent } = await import("@onzo/ozon-order/webhook");
    const { processCancelledOrder, processStatusChange } = await import("./services/order-processor.js");
    await handleWebhookEvent(
      {
        eventType: (data.eventType || "order.status_changed") as "order.status_changed",
        postingNumber: (body.posting_number as string) || "",
        orderId: (body.order_id as number) || 0,
        status: ((body.status as string) || "awaiting_deliver") as "awaiting_deliver",
        timestamp: new Date().toISOString(),
        rawBody: JSON.stringify(body),
        eventId: task.id,
      },
      {
        onStatusChanged: async (p) => { await processStatusChange(p.postingNumber, p.status); },
        onDelivered: async (p) => { await processStatusChange(p.postingNumber, "delivered"); },
        onCancelled: async (p) => { await processCancelledOrder(p.postingNumber, "store_1"); },
      }
    );
    logger.info({ taskId: task.id }, "Webhook retry task processed");
  } catch (err) {
    logger.error({ taskId: task.id, err: (err as Error).message }, "Webhook retry handler failed");
    throw err;
  }
});
mountApi("", createProcessRouter(config, taskQueue));

const { OzonClient, AuthManager } = await import("@onzo/ozon-api-wrapper");
const ozonClient = new OzonClient({
  auth: new AuthManager({ clients: [{ clientId: config.ozon.clientId, apiKey: config.ozon.apiKey }] }),
  baseUrl: config.ozon.baseUrl,
});

// Shared AI clients (also used by process route internally)
const { DeepSeekClient, GlmVisionClient, TokenTracker } = await import("@onzo/glm-integration");
const tokenTracker = new TokenTracker({
  dailyLimit: parseInt(process.env.LLM_DAILY_TOKEN_LIMIT || "0", 10),
});
const sharedDeepseekClient = new DeepSeekClient({
  apiKey: config.deepseek.apiKey,
  baseUrl: config.deepseek.baseUrl,
  flashModel: config.deepseek.flashModel,
  proModel: config.deepseek.proModel,
  tokenTracker,
});
const sharedVisionClient = new GlmVisionClient({
  apiKey: config.glm.apiKey,
  baseUrl: `${config.glm.baseUrl}/chat/completions`,
  model: config.glm.visionModel,
  tokenTracker,
});

app.use(createHealthRouter(ozonClient));
mountApi("", createDiagnoseRouter(ozonClient));
mountApi("", createOrderRouter(ozonClient));
mountApi("", createBulkRouter(taskQueue));
mountApi("", createDashboardRouter(taskQueue));
app.use("/api/analyze", createAnalyzeRouter());
// COS Image Upload — mounted under both v1 and legacy /api
const cosUploader = new CosUploader(db);
const { validate: validateZod, CosUploadSchema, CosBatchUploadSchema } = await import("./middleware/validate.js");
const cosRouter = express.Router();
cosRouter.post('/images/upload', validateZod(CosUploadSchema), async (req, res) => {
  try {
    const { filePath, productId, key } = req.body as { filePath: string; productId: string; key?: string };
    const result = await cosUploader.uploadImage(filePath, productId, key);
    res.json({ success: result.success, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

cosRouter.post('/images/batch-upload', validateZod(CosBatchUploadSchema), async (req, res) => {
  try {
    const { files } = req.body as { files: Array<{ filePath: string; productId: string; key?: string }> };
    const results = await cosUploader.uploadImagesBatch(files);
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

cosRouter.post('/images/retry-dead-letter', async (_req, res) => {
  try {
    const results = await cosUploader.retryDeadLetterImages();
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
app.use("/api", cosRouter);
app.use(`${API_V1}`, cosRouter);

mountApi("/inventory", createInventoryRouter());
mountApi("/aftersales", createAftersalesRouter());
mountApi("", createAlertRouter());
mountApi("", createPromoRouter());
mountApi("", createOpsRouter());
// Ozon Order Sync v2 routes
const { createOzonOrderRouter } = await import("./routes/ozon-order.route.js");
mountApi("", createOzonOrderRouter(db, ozonClient));
// Purchase Pay routes (1688 auto-payment)
const { createPurchasePayRouter } = await import("./routes/purchase-pay.route.js");
mountApi("", createPurchasePayRouter(db));
// 1688 Message Callback (order/payment/logistics push events)
const { create1688CallbackRouter } = await import("./routes/1688-callback.route.js");
mountApi("", create1688CallbackRouter());
mountApi("", ragRateLimit, createRagRouter());

// Data export routes
const { createExportRouter } = await import("./routes/export.route.js");
mountApi("", createExportRouter());

// Oozo: process 1688 plugin downloads (images + videos → Russian localized)
const { createOozoRouter } = await import("./routes/oozo.route.js");
mountApi("", createOozoRouter(sharedDeepseekClient, sharedVisionClient, ozonClient));
// SKU-1688 Mapping routes
const { createSkuMappingRouter } = await import("./routes/sku-mapping.route.js");
mountApi("", createSkuMappingRouter());
// Logistics routes (freight forwarder tracking → Ozon backfill)
const { createLogisticsRouter } = await import("./routes/logistics.route.js");
mountApi("", createLogisticsRouter(ozonClient));
// Report routes (finance, alerts, Excel export, daily routine)
const { createReportRouter } = await import("./routes/report.route.js");
mountApi("", createReportRouter());

// Procurement routes (MANUAL_PAY_MODE) — 1688采购管理
const { createProcurementRouter } = await import("./routes/procurement.route.js");
mountApi("", createProcurementRouter(ozonClient));

// LangGraph Workflow Routes (procurement + RAG + full pipeline)
const { createLangGraphRouter } = await import("./routes/langgraph.route.js");
mountApi("", createLangGraphRouter());
const { createPipelineRouter } = await import("./routes/pipeline.route.js");
mountApi("", createPipelineRouter());

// Market Analysis Routes (7-module Ozon market intelligence)
const { createMarketRouter } = await import("./routes/market.route.js");
mountApi("", createMarketRouter());

// Direct listing — AI translate + Ozon API (no scraper)
const { createDirectListRouter } = await import("./routes/direct-list.route.js");
mountApi("", createDirectListRouter());

// 1688 Plugin data receiver
const { createPluginRouter } = await import("./routes/plugin.route.js");
mountApi("", createPluginRouter());

// Product Selection Lists (毛子ERP风格选品榜单)
const { createSelectionRouter } = await import("./routes/selection.route.js");
mountApi("", createSelectionRouter());

// Ozon Profit Calculator
// Disabled: profit-calc.route.ts not in Docker image yet
// const { createProfitCalcRouter } = await import("./routes/profit-calc.route.js");
// mountApi("", createProfitCalcRouter());

// Task scheduler routes
const { createTaskTriggerRouter } = await import("./routes/task.route.js");
app.use("/api/task", createTaskTriggerRouter());
app.use("/api/v1/task", createTaskTriggerRouter());

// Start cron-based scheduled tasks (02:00 market poll, 08:00 price adjust)
const { startScheduledTasks } = await import("./task/schedule-task.js");
startScheduledTasks();

// ---- Request Metrics (path-normalized to prevent Prometheus cardinality explosion) ----

/** Replace dynamic path segments with :param placeholders to bound metric cardinality. */
function normalizePath(path: string): string {
  // UUIDs
  let normalized = path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":uuid");
  // Numeric IDs (standalone or path segments)
  normalized = normalized.replace(/\/\d+/g, "/:id");
  // ISO date strings
  normalized = normalized.replace(/\d{4}-\d{2}-\d{2}/g, ":date");
  return normalized;
}

app.use((req, res, next) => {
  const start = Date.now();
  const route = normalizePath(req.path);
  const method = req.method;

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    requestCounter.inc({ path: route, method, status_code: res.statusCode.toString() });
    requestDuration.observe({ path: route, method }, duration);
  });

  next();
});

app.use(errorHandler);

const server = app.listen(config.port, () => {
  logger.info(`ONZO API Services running on http://localhost:${config.port}`);
  logger.info(`Environment: ${config.nodeEnv}`);

  // Run startup smoke tests — non-blocking, results logged
  runSmokeTests(ozonClient).catch(() => {});

  // Start logistics polling (1688 tracking → freight forwarder)
  startLogisticsPolling();

  // Register logistics monitoring job (LOGISTICS_ENABLE flag)
  if (process.env.LOGISTICS_ENABLE === "true") {
    registerJob("logistics-delay-check", 30 * 60_000, async () => {
      const { LogisticsOrchestrator } = await import("./services/logistics-orchestrator.js");
      const orchestrator = new LogisticsOrchestrator(db);
      const alertCount = await orchestrator.checkDelays();
      if (alertCount > 0) {
        logger.warn({ alertCount }, "Scheduled logistics delay check — alerts sent");
      }
    });
    logger.info("Logistics module ENABLED — auto-shipment + tracking webhooks active");
  }

  // Register transition logistics alert jobs (TRANSITION_LOGISTICS=kuajingbus)
  if (process.env.TRANSITION_LOGISTICS === "kuajingbus") {
    registerJob("transition-24h-check", 60 * 60_000, async () => {
      const { TransitionLogisticsService } = await import("./services/transition-logistics.js");
      const service = new TransitionLogisticsService(db);
      await service.check24hOverdue();
    });
    registerJob("transition-48h-check", 120 * 60_000, async () => {
      const { TransitionLogisticsService } = await import("./services/transition-logistics.js");
      const service = new TransitionLogisticsService(db);
      await service.check48hOverdue();
    });
    logger.info("Transition logistics ENABLED — 跨境巴士 semi-auto workflow + TG alerts active");
  }

  // Register Redis health check (all modes — alerts on disconnect)
  registerJob("redis-health-check", 5 * 60_000, async () => {
    const { checkRedisHealth } = await import("./services/redis-health.js");
    await checkRedisHealth();
  });

  // Register Ozon category tree daily refresh (keeps category IDs in sync)
  registerJob("category-tree-refresh", 24 * 3600_000, async () => {
    const { refreshCategoryTree } = await import("./services/category-resolver.js");
    try {
      const count = await refreshCategoryTree();
      logger.info({ count }, "Daily category tree refresh complete");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Category tree refresh failed — will retry tomorrow");
    }
  });

  // Register manual procurement jobs (MANUAL_PAY_MODE=true)
  if (process.env.MANUAL_PAY_MODE === "true") {
    registerJob("procurement-sync", 10 * 60_000, async () => {
      const { ManualProcurementService } = await import("./services/manual-procurement.js");
      const service = new ManualProcurementService(db);
      const result = await service.runProcurementBatch(ozonClient);
      if (result.created > 0 || result.failed > 0) {
        logger.info({ created: result.created, failed: result.failed, profitBlocked: result.profitBlocked }, "Procurement batch complete");
      }
    }, { timeoutMs: 5 * 60_000 });
    registerJob("procurement-unpaid-reminder", 60 * 60_000, async () => {
      const { ManualProcurementService } = await import("./services/manual-procurement.js");
      const service = new ManualProcurementService(db);
      const count = await service.remindUnpaidOrders();
      if (count > 0) logger.warn({ count }, "Unpaid purchase reminders sent");
    });
    registerJob("procurement-status-poll", 30 * 60_000, async () => {
      const { ManualProcurementService } = await import("./services/manual-procurement.js");
      const service = new ManualProcurementService(db);
      await service.pollPurchaseStatus();
    });
    logger.info("Manual procurement ENABLED — 1688 purchase orders created without auto-pay");
  }
});

registerCleanup(async () => {
  stopLogisticsPolling();
  await shutdownTracing();
});

setupShutdownHandlers(server, {
  info: (msg: string) => logger.info(msg),
  error: (obj: unknown, msg: string) => logger.error(obj as Record<string, unknown>, msg),
});

export { app };

