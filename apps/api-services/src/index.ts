// ============================================================
// ONZO API Services — Express HTTP server
// Phase 1: single-store MVP
// ============================================================

import express, { type RequestHandler } from "express";
import cors from "cors";
import { loadConfig } from "./config.js";
import { correlationIdMiddleware } from "./middleware/correlation-id.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createLogger } from "./middleware/logger.js";
import { createHealthRouter } from "./routes/health.route.js";
import { createTaskRouter } from "./routes/task.route.js";
import { createProcessRouter } from "./routes/process.route.js";
import { createStatsRouter } from "./routes/stats.route.js";
import { createBackupRouter } from "./routes/backup.route.js";
import { createOrderRouter } from "./routes/order.route.js";
import { createWebhookRouter } from "./routes/webhook.route.js";
import { createBulkRouter } from "./routes/bulk.route.js";
import { createDashboardRouter } from "./routes/dashboard.route.js";
import { createPriceRouter } from "./routes/price.route.js";
import { createStoreRouter } from "./routes/store.route.js";
import { createDashboardHtmlRouter } from "./routes/dashboard-html.route.js";
import { timeoutMiddleware } from "./middleware/timeout.js";
import { idempotencyMiddleware } from "./middleware/idempotency.js";
import { mockMiddleware } from "./routes/mock.middleware.js";
import { swaggerSpec } from "./swagger.js";
import { getDb } from "./db/connection.js";

// Dynamic import for swagger-ui-express (optional dependency)
let swaggerUi: { serve: unknown; setup: (spec: unknown) => unknown } | null = null;
async function loadSwagger() {
  try { swaggerUi = (await import("swagger-ui-express")).default as typeof swaggerUi; } catch { /* optional */ }
}

const config = loadConfig();
const logger = createLogger(config);
const app = express();

// ---- Middleware ----
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(timeoutMiddleware(120_000));
app.use(correlationIdMiddleware);
app.use(idempotencyMiddleware);
app.use(mockMiddleware);

// ---- Routes ----
app.use(createHealthRouter());
app.use("/api", createStatsRouter());
app.use("/api", createBackupRouter());
app.use("/api", createWebhookRouter());
app.use("/api", createPriceRouter());
app.use("/api", createStoreRouter());

// ---- HTML Dashboard (GET /) ----
app.use(createDashboardHtmlRouter());

// ---- Swagger docs ----
await loadSwagger();
if (swaggerUi) {
  app.use("/api/docs", swaggerUi.serve as express.RequestHandler, swaggerUi.setup(swaggerSpec));
}

// ---- Init DB & Queue ----
async function start(): Promise<void> {
  const db = await getDb().catch((err) => {
    logger.warn({ err }, "DB not available — running without persistence");
    return null;
  });

  // Dynamic import for task-queue (requires DB)
  const { TaskQueue } = await import("./db/task-queue.js");
  const taskQueue = new TaskQueue(db);
  await taskQueue.init();
  logger.info({ stats: taskQueue.getStats() }, "Task queue initialized");

  // Mount task routes (depends on queue)
  app.use("/api/task", createTaskRouter(taskQueue));

  // Mount process routes
  app.use("/api", createProcessRouter(config, taskQueue));

  // Mount order routes
  const { OzonClient, AuthManager } = await import("@onzo/ozon-api-wrapper");
  const ozonClient = new OzonClient({
    auth: new AuthManager({ clients: [{ clientId: config.ozon.clientId, apiKey: config.ozon.apiKey }] }),
    baseUrl: config.ozon.baseUrl,
  });
  app.use("/api", createOrderRouter(ozonClient));
  app.use("/api", createBulkRouter(taskQueue));
  app.use("/api", createDashboardRouter(taskQueue));

  // ---- Error handling ----
  app.use(errorHandler);

  // ---- Start ----
  app.listen(config.port, () => {
    logger.info(`ONZO API Services running on http://localhost:${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
  });
}

start().catch((err) => {
  logger.fatal({ err }, "Failed to start server");
  process.exit(1);
});

// Note: routes are mounted asynchronously via start().
// Do not import this module for programmatic use — use a child process or Docker.
export { app };
