import express from "express";
import cors from "cors";
import { loadConfig } from "./config.js";
import { validateProductionConfig } from "./config-validation.js";
import { correlationIdMiddleware } from "./middleware/correlation-id.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createLogger } from "./middleware/logger.js";
import { createHealthRouter } from "./routes/health.route.js";
import { createTaskRouter } from "./routes/task.route.js";
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
import { timeoutMiddleware } from "./middleware/timeout.js";
import { idempotencyMiddleware } from "./middleware/idempotency.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { registerCleanup, setupShutdownHandlers } from "./middleware/shutdown.js";
import { mockMiddleware } from "./routes/mock.middleware.js";
import { requestTimingMiddleware } from "./middleware/request-timing.js";
import { swaggerSpec } from "./swagger.js";
import { getDb } from "./db/connection.js";
import { initTracing, shutdownTracing } from "./tracing/index.js";
import { collectMetrics, requestCounter, requestDuration } from "./metrics/index.js";

let swaggerUi: { serve: unknown; setup: (spec: unknown) => unknown } | null = null;
async function loadSwagger() {
  try { swaggerUi = (await import("swagger-ui-express")).default as typeof swaggerUi; } catch { }
}

const config = loadConfig();
validateProductionConfig();
const logger = createLogger(config);

// Optional OpenTelemetry tracing (no-op unless OTEL_ENABLED=true)
initTracing("onzo-api-services").catch(() => {});

const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS || "https://124-221-11-222.nip.io,http://localhost:3000,http://localhost:5678")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : undefined,
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "X-Correlation-ID"],
  maxAge: 86400,
}));

app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  },
}));

app.use(timeoutMiddleware(120_000));
app.use(correlationIdMiddleware);
app.use(rateLimitMiddleware);
app.use(idempotencyMiddleware);
app.use(authMiddleware);
app.use(requestTimingMiddleware);
app.use(mockMiddleware);

// Serve downloaded images for Ozon URL import (Ozon has no local-file upload API)
import { mkdirSync, existsSync } from "node:fs";
const tmpImgDir = "./data/tmp-images";
if (!existsSync(tmpImgDir)) mkdirSync(tmpImgDir, { recursive: true });
app.use("/tmp-images", express.static(tmpImgDir, { maxAge: 300_000 }));

app.use(createHealthRouter());
app.use("/api", createStatsRouter());
app.use("/api", createBackupRouter());
app.use("/api", createWebhookRouter());
app.use("/api", createPriceRouter());
app.use("/api", createStoreRouter());
app.use("/api", createStoreAdminRouter());

app.use(createDashboardHtmlRouter());

await loadSwagger();
if (swaggerUi) {
  app.use("/api/docs", swaggerUi.serve as express.RequestHandler, swaggerUi.setup(swaggerSpec));
}

app.get("/metrics", async (_req, res) => {
  try {
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
}

const { TaskQueue } = await import("./db/task-queue.js");
const taskQueue = new TaskQueue(db, config.maxTaskConcurrency);
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

app.use("/api/task", createTaskRouter(taskQueue));
app.use("/api", createProcessRouter(config, taskQueue));

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

app.use("/api", createOrderRouter(ozonClient));
app.use("/api", createBulkRouter(taskQueue));
app.use("/api", createDashboardRouter(taskQueue));
app.use("/api/analyze", createAnalyzeRouter());
// COS Image Upload
const cosUploader = new CosUploader(db);
app.post('/api/images/upload', async (req, res) => {
  try {
    const { filePath, productId, key } = req.body as { filePath: string; productId: string; key?: string };
    if (!filePath || !productId) {
      res.status(400).json({ success: false, error: 'filePath and productId required' });
      return;
    }
    const result = await cosUploader.uploadImage(filePath, productId, key);
    res.json({ success: result.success, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.post('/api/images/batch-upload', async (req, res) => {
  try {
    const { files } = req.body as { files: Array<{ filePath: string; productId: string; key?: string }> };
    if (!files || !Array.isArray(files)) {
      res.status(400).json({ success: false, error: 'files array required' });
      return;
    }
    const results = await cosUploader.uploadImagesBatch(files);
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.post('/api/images/retry-dead-letter', async (_req, res) => {
  try {
    const results = await cosUploader.retryDeadLetterImages();
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.use("/api/inventory", createInventoryRouter());
app.use("/api/aftersales", createAftersalesRouter());

// Oozo: process 1688 plugin downloads (images + videos 鈫?Russian localized)
const { createOozoRouter } = await import("./routes/oozo.route.js");
app.use("/api", createOozoRouter(sharedDeepseekClient, sharedVisionClient, ozonClient));

app.use((req, res, next) => {
  const start = Date.now();
  const route = req.path;
  const method = req.method;
  
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    requestCounter.inc({ route, method, status_code: res.statusCode });
    requestDuration.observe({ route, method }, duration);
  });
  
  next();
});

app.use(errorHandler);

const server = app.listen(config.port, () => {
  logger.info(`ONZO API Services running on http://localhost:${config.port}`);
  logger.info(`Environment: ${config.nodeEnv}`);
});

registerCleanup(async () => {
  await shutdownTracing();
});

setupShutdownHandlers(server, {
  info: (msg: string) => logger.info(msg),
  error: (obj: unknown, msg: string) => logger.error(obj as Record<string, unknown>, msg),
});

export { app };

