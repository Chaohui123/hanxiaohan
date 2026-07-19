// ============================================================
// ONZO API Services — Entry Point
// Orchestrates: config → middleware → routes → jobs → server
// ============================================================

import express from "express";
import cors from "cors";
import helmet from "helmet";
import { mkdirSync, existsSync } from "node:fs";

import { loadConfig } from "./config.js";
import { validateProductionConfig } from "./config-validation.js";
import { createLogger } from "./middleware/logger.js";
import { getDb } from "./db/connection.js";

// ---- Middleware ----
import { timeoutMiddleware } from "./middleware/timeout.js";
import { correlationIdMiddleware } from "./middleware/correlation-id.js";
import { accessLogMiddleware } from "./middleware/access-log.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { idempotencyMiddleware } from "./middleware/idempotency.js";
import { authMiddleware } from "./middleware/auth.js";
import { auditMiddleware } from "./middleware/audit.js";
import { requestTimingMiddleware } from "./middleware/request-timing.js";
import { mockMiddleware } from "./routes/mock.middleware.js";
import { errorHandler } from "./middleware/error-handler.js";
import { registerCleanup, setupShutdownHandlers } from "./middleware/shutdown.js";

// ---- Metrics ----
import { collectMetrics, requestCounter, requestDuration, refreshPoolMetrics } from "./metrics/index.js";

// ---- Jobs & Routes (extracted modules) ----
import { registerCoreJobs, registerConditionalJobs } from "./jobs/setup.js";
import { mountAllRoutes } from "./routes/mount-all.js";

// ---- OTEL tracing (lazy, non-blocking) ----
let initTracing = async (_name: string) => {};
let shutdownTracing = async () => {};
async function loadTracing() {
  try {
    const mod = await import("./tracing/index.js");
    initTracing = mod.initTracing;
    shutdownTracing = mod.shutdownTracing;
  } catch { /* OTEL unavailable */ }
}

// ============================================================
// 1. Config & Logging
// ============================================================
const config = loadConfig();
validateProductionConfig();
const logger = createLogger(config);

await loadTracing();
initTracing("onzo-api-services").catch(() => {});

// ============================================================
// 2. Express App + Middleware
// ============================================================
const app: express.Express = express();

const isProduction = (process.env.ENV || process.env.NODE_ENV) === "production";
const corsFallback = isProduction ? "" : "http://localhost:3000,http://localhost:5173,http://localhost:5678";
const allowedOrigins = (process.env.CORS_ORIGINS || corsFallback)
  .split(",").map((s) => s.trim()).filter(Boolean);

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
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"], connectSrc: ["'self'"], fontSrc: ["'self'"],
      objectSrc: ["'none'"], mediaSrc: ["'self'"], frameSrc: ["'none'"],
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
  verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; },
}));

app.use(timeoutMiddleware(120_000));
app.use(correlationIdMiddleware);
app.use(accessLogMiddleware);
app.use(rateLimitMiddleware);
const { ozonRateLimiter } = await import("./middleware/ozon-rate-limiter.js");
app.use(ozonRateLimiter);
app.use(idempotencyMiddleware);
app.use(authMiddleware);
app.use(auditMiddleware);
app.use(requestTimingMiddleware);
app.use(mockMiddleware);

// ============================================================
// 3. Static file serving
// ============================================================
const tmpImgDir = "./data/tmp-images";
if (!existsSync(tmpImgDir)) mkdirSync(tmpImgDir, { recursive: true });
app.use("/tmp-images", express.static(tmpImgDir, { maxAge: 300_000 }));

const imgDir = process.env.IMAGE_STORAGE_PATH || "./data/images";
if (!existsSync(imgDir)) mkdirSync(imgDir, { recursive: true });
app.use("/images", express.static(imgDir, { maxAge: 86400_000 }));

// Three-tier image storage: raw → preprocessed → GLM-optimized (P3)
import { getImageDirs } from "./services/image-processor.js";
const imgDirs = getImageDirs();
app.use("/images/raw", express.static(imgDirs.raw, { maxAge: 86400_000 }));
app.use("/images/preprocessed", express.static(imgDirs.preprocessed, { maxAge: 86400_000 }));
app.use("/images/optimized", express.static(imgDirs.optimized, { maxAge: 86400_000 }));

// ============================================================
// 4. mountApi helper (shared by route mounting)
// ============================================================
const API_V1 = "/api/v1";

function mountApi(path: string, ...handlers: (express.RequestHandler | express.Router)[]): void {
  app.use(`${API_V1}${path}`, ...handlers);
  app.use(`/api${path}`, (req, res, next) => {
    res.setHeader("X-API-Deprecated", "true");
    res.setHeader("X-API-Deprecation-Date", "2026-10-01");
    res.setHeader("Sunset", "2027-04-01");
    next();
  }, ...handlers);
}

// ============================================================
// 5. /metrics endpoint
// ============================================================
app.get("/metrics", async (_req, res) => {
  try {
    const { getPoolStats } = await import("./db/connection.js");
    refreshPoolMetrics(getPoolStats());
    const poolStats = getPoolStats();
    if (poolStats.waiting > 10) {
      logger.warn({ poolStats }, "DB connection pool exhausted — waiting count > 10");
      const { emitEvent } = await import("./services/notification-events.js");
      emitEvent("CIRCUIT_BREAKER_OPEN", { service: "db-pool", failures: String(poolStats.waiting) }).catch(() => {});
    }
    const metrics = await collectMetrics();
    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(metrics);
  } catch {
    res.status(500).send("Failed to collect metrics");
  }
});

// ============================================================
// 6. DB connection
// ============================================================
const db = await getDb().catch((err) => {
  logger.warn({ err }, "DB not available — running without persistence");
  return null;
});

if (db) {
  const { startAutoBackup, stopAutoBackup } = await import("./routes/backup.route.js");
  startAutoBackup();
  registerCleanup(async () => { stopAutoBackup(); });
  registerCleanup(async () => { const { closeDb } = await import("./db/connection.js"); await closeDb(); });
}

// ============================================================
// 7. Shared service clients (needed by both routes and jobs)
// ============================================================
const { OzonClient, AuthManager } = await import("@onzo/ozon-api-wrapper");
const ozonClient = new OzonClient({
  auth: new AuthManager({ clients: [{ clientId: config.ozon.clientId, apiKey: config.ozon.apiKey }] }),
  baseUrl: config.ozon.baseUrl,
});

const { DeepSeekClient, GlmVisionClient, TokenTracker } = await import("@onzo/glm-integration");
const tokenTracker = new TokenTracker({
  dailyLimit: parseInt(process.env.LLM_DAILY_TOKEN_LIMIT || "0", 10),
});
const sharedDeepseekClient = new DeepSeekClient({
  apiKey: config.deepseek.apiKey, baseUrl: config.deepseek.baseUrl,
  flashModel: config.deepseek.flashModel, proModel: config.deepseek.proModel, tokenTracker,
});
const sharedVisionClient = new GlmVisionClient({
  apiKey: config.kimi.apiKey, baseUrl: `${config.kimi.baseUrl}/chat/completions`,
  model: config.kimi.visionModel, tokenTracker,
});

// ============================================================
// 8. Task Queue
// ============================================================
const { TaskQueue } = await import("./db/task-queue.js");
const taskQueue = new TaskQueue(db ?? undefined, config.maxTaskConcurrency);
await taskQueue.init();
logger.info({ stats: taskQueue.getStats() }, "Task queue initialized");

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
        timestamp: new Date().toISOString(), rawBody: JSON.stringify(body), eventId: task.id,
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

// ============================================================
// 8a. Shared listing infrastructure (browser pool, scraper, AI clients)
// One instance per process — used by the process route AND the auto-publish job
// ============================================================
const { createListingInfra } = await import("./services/listing-runner.js");
const listingInfra = createListingInfra(config);

// ============================================================
// 9. Register core jobs (must be before startScheduler)
// ============================================================
registerCoreJobs({ db, ozonClient, tokenTracker, logger, config, taskQueue, listingInfra });

// ============================================================
// 10. Mount all routes
// ============================================================
await mountAllRoutes(app, {
  config, db, ozonClient, taskQueue,
  sharedDeepseekClient, sharedVisionClient, tokenTracker, listingInfra, logger,
  mountApi, API_V1,
});

// ============================================================
// 11. Start scheduler + RAG indexer
// ============================================================
import { startScheduler, stopScheduler } from "./services/scheduler.js";
startScheduler();

import { RagIndexer } from "./services/rag-indexer.js";
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

// Start cron-based scheduled tasks (02:00 market poll, 08:00 price adjust)
const { startScheduledTasks } = await import("./task/schedule-task.js");
startScheduledTasks();

// ---- P4: BullMQ async queue (Redis-backed, falls back to in-memory) ----
const { setFallbackQueue } = await import("./services/bullmq-queue.js");
setFallbackQueue(taskQueue);

// ---- P4: Dashboard cron (01:50 keyword, 02:00 dashboard, 22:00 report) ----
const { startDashboardCron } = await import("./jobs/dashboard-cron.js");
startDashboardCron();

// ============================================================
// 12. Request metrics middleware (must be after routes)
// ============================================================
function normalizePath(path: string): string {
  let normalized = path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":uuid");
  normalized = normalized.replace(/\/\d+/g, "/:id");
  normalized = normalized.replace(/\d{4}-\d{2}-\d{2}/g, ":date");
  return normalized;
}

app.use((req, res, next) => {
  const start = Date.now();
  const route = normalizePath(req.path);
  const method = req.method;
  res.on("finish", () => {
    const duration = (Date.now() - start) / 1000;
    requestCounter.inc({ path: route, method, status_code: res.statusCode.toString() });
    requestDuration.observe({ path: route, method }, duration);
  });
  next();
});

app.use(errorHandler);

// ============================================================
// 13. Start server
// ============================================================
import { startLogisticsPolling, stopLogisticsPolling } from "./services/logistics-polling.js";
import { runSmokeTests } from "./startup-smoke-test.js";

const server = app.listen(config.port, () => {
  logger.info(`ONZO API Services running on http://localhost:${config.port}`);
  logger.info(`Environment: ${config.nodeEnv}`);

  // WebSocket relay for plugin bridge (legacy ws)
  import("./services/ws-relay.js").then(({ startWsRelay }) => startWsRelay(server)).catch(() => {});

  // P2: Socket.io relay (modern bidirectional, replaces ws long-term)
  import("./services/socketio-relay.js").then(({ startSocketIoRelay }) => startSocketIoRelay(server)).catch(() => {});

  // P2: Chrome controller — attempt CDP connection for headless automation
  import("./services/chrome-controller.js").then(({ getChromeController }) => {
    const ctrl = getChromeController();
    ctrl.isBrowserAvailable().then((ok) => {
      if (ok) { ctrl.connect().catch(() => {}); }
    }).catch(() => {});
  }).catch(() => {});

  // P3: Enhanced image processing with background removal (preload check)
  if (process.env.IMAGE_PREPROCESS_ENABLE !== "false") {
    logger.info("Image preprocessing ENABLED — background removal + 1:1 crop active");
  }

  // Startup smoke tests (non-blocking)
  runSmokeTests(ozonClient).catch(() => {});

  // Logistics polling (1688 tracking → freight forwarder)
  startLogisticsPolling();

  // Conditional runtime jobs
  registerConditionalJobs({ db, ozonClient, tokenTracker, logger, config, taskQueue, listingInfra });
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
