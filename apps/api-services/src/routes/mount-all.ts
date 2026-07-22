// ============================================================
// Centralized route mounting — all API routes registered here
// Extracted from index.ts to keep the entrypoint lean.
// ============================================================

import express from "express";
import type { AppConfig } from "../config.js";

// ---- Route creator imports ----
import { createHealthRouter } from "./health.route.js";
import { createStatsRouter } from "./stats.route.js";
import { createBackupRouter } from "./backup.route.js";
import { createOrderRouter } from "./order.route.js";
import { createWebhookRouter } from "./webhook.route.js";
import { createBulkRouter } from "./bulk.route.js";
import { createDashboardRouter } from "./dashboard.route.js";
import { createPriceRouter } from "./price.route.js";
import { createStoreRouter } from "./store.route.js";
import { createStoreAdminRouter } from "./store-admin.route.js";
import { createDashboardHtmlRouter } from "./dashboard-html.route.js";
import { createAnalyzeRouter } from "./analyze.route.js";
import { createInventoryRouter } from "./inventory.route.js";
import { createAftersalesRouter } from "./aftersales.route.js";
import { createAlertRouter } from "./alert.route.js";
import { createPromoRouter } from "./promo.route.js";
import { createRagRouter } from "./rag.route.js";
import { createDiagnoseRouter } from "./diagnose.route.js";
import { createOpsRouter } from "./ops.route.js";
import { createProcessRouter } from "./process.route.js";
import { ragRateLimit } from "../middleware/rag-rate-limit.js";
import { swaggerSpec } from "../swagger.js";

// ---- Service imports for inline routers ----
import { CosUploader } from "../services/cos-uploader.js";

// ---- Types ----
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import type { DeepSeekClient, GlmVisionClient, TokenTracker } from "@onzo/glm-integration";
import type { ListingInfra } from "../services/listing-runner.js";

// Internal deps — use lightweight types to avoid circular imports from db/task-queue modules
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleLike = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TaskQueueLike = any;

export interface RouteDeps {
  config: AppConfig;
  db: DrizzleLike | null;
  ozonClient: OzonClient;
  taskQueue: TaskQueueLike;
  sharedDeepseekClient: DeepSeekClient;
  sharedVisionClient: GlmVisionClient;
  tokenTracker: TokenTracker;
  listingInfra: ListingInfra;
  logger: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };
  /** Mount a router at both /api/v1 (current) and /api (deprecated). */
  mountApi: (path: string, ...handlers: express.RequestHandler[]) => void;
  API_V1: string;
}

export async function mountAllRoutes(app: express.Express, deps: RouteDeps): Promise<void> {
  const { config, db, ozonClient, taskQueue, sharedDeepseekClient, sharedVisionClient, listingInfra, mountApi, API_V1 } = deps;

  // ---- Basic routes (no deps required) ----
  mountApi("", createStatsRouter());
  mountApi("", createBackupRouter());

  // Webhook: mounted directly (no mountApi) to avoid deprecation headers interfering with Ozon
  app.use("/api", createWebhookRouter());
  app.use("/api/v1", createWebhookRouter());
  // Canonical event-driven path: /ozon/webhook
  app.use("/ozon", createWebhookRouter());

  mountApi("", createPriceRouter());
  mountApi("", createStoreRouter());
  mountApi("", createStoreAdminRouter());

  app.use(createDashboardHtmlRouter());

  // Swagger docs (if available)
  let swaggerUi: { serve: express.RequestHandler; setup: (spec: unknown) => express.RequestHandler } | null = null;
  try { swaggerUi = (await import("swagger-ui-express")).default as unknown as typeof swaggerUi; } catch { /* optional */ }
  if (swaggerUi) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui = swaggerUi as any;
    app.use("/api/docs", ui.serve, ui.setup(swaggerSpec));
  }

  // ---- Routes depending on ozonClient ----
  app.use(createHealthRouter(ozonClient));
  mountApi("", createDiagnoseRouter(ozonClient));
  mountApi("", createOrderRouter(ozonClient));

  // ---- Routes depending on taskQueue ----
  mountApi("", createBulkRouter(taskQueue));
  mountApi("", createDashboardRouter(taskQueue));

  // ---- Process route (needs config + taskQueue + shared listing infra) ----
  mountApi("", createProcessRouter(config, taskQueue, listingInfra));

  // ---- COS Image Upload (inline router) ----
  const cosUploader = new CosUploader(db);
  const { validate: validateZod, CosUploadSchema, CosBatchUploadSchema } = await import("../middleware/validate.js");
  const cosRouter = express.Router();
  cosRouter.post("/images/upload", validateZod(CosUploadSchema), async (req, res) => {
    try {
      const { filePath, productId, key } = req.body as { filePath: string; productId: string; key?: string };
      const result = await cosUploader.uploadImage(filePath, productId, key);
      res.json({ success: result.success, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });
  cosRouter.post("/images/batch-upload", validateZod(CosBatchUploadSchema), async (req, res) => {
    try {
      const { files } = req.body as { files: Array<{ filePath: string; productId: string; key?: string }> };
      const results = await cosUploader.uploadImagesBatch(files);
      res.json({ success: true, data: results });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });
  cosRouter.post("/images/retry-dead-letter", async (_req, res) => {
    try {
      const results = await cosUploader.retryDeadLetterImages();
      res.json({ success: true, data: results });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });
  app.use("/api", cosRouter);
  app.use(`${API_V1}`, cosRouter);

  // ---- Analyzer route ----
  app.use("/api/analyze", createAnalyzeRouter());

  // ---- Resource routes ----
  mountApi("/inventory", createInventoryRouter());
  mountApi("/aftersales", createAftersalesRouter());
  mountApi("", createAlertRouter());
  mountApi("", createPromoRouter());
  mountApi("", createOpsRouter());

  // ---- Ozon Order Sync v2 routes ----
  const { createOzonOrderRouter } = await import("./ozon-order.route.js");
  mountApi("", createOzonOrderRouter(db, ozonClient));

  // ---- Purchase Pay routes (1688 auto-payment) ----
  const { createPurchasePayRouter } = await import("./purchase-pay.route.js");
  mountApi("", createPurchasePayRouter(db));

  // ---- 1688 Message Callback (order/payment/logistics push events) ----
  const { create1688CallbackRouter } = await import("./1688-callback.route.js");
  mountApi("", create1688CallbackRouter());

  // ---- RAG routes (rate-limited) ----
  mountApi("", ragRateLimit, createRagRouter());

  // ---- Data export routes ----
  const { createExportRouter } = await import("./export.route.js");
  mountApi("", createExportRouter());

  // ---- Oozo: process 1688 plugin downloads ----
  const { createOozoRouter } = await import("./oozo.route.js");
  mountApi("", createOozoRouter(sharedDeepseekClient, sharedVisionClient, ozonClient));

  // ---- SKU-1688 Mapping routes ----
  const { createSkuMappingRouter } = await import("./sku-mapping.route.js");
  mountApi("", createSkuMappingRouter());

  // ---- Logistics routes (freight forwarder tracking) ----
  const { createLogisticsRouter } = await import("./logistics.route.js");
  mountApi("", createLogisticsRouter(ozonClient));

  // ---- Report routes (finance, alerts, Excel export) ----
  const { createReportRouter } = await import("./report.route.js");
  mountApi("", createReportRouter());

  // ---- Procurement routes (MANUAL_PAY_MODE) ----
  const { createProcurementRouter } = await import("./procurement.route.js");
  mountApi("", createProcurementRouter(ozonClient));

  // ---- LangGraph Workflow Routes ----
  const { createLangGraphRouter } = await import("./langgraph.route.js");
  mountApi("", createLangGraphRouter());
  const { createPipelineRouter } = await import("./pipeline.route.js");
  mountApi("", createPipelineRouter());

  // ---- Market Analysis Routes ----
  const { createMarketRouter } = await import("./market.route.js");
  mountApi("", createMarketRouter());

  // ---- Direct listing (AI translate + Ozon API) ----
  const { createDirectListRouter } = await import("./direct-list.route.js");
  mountApi("", createDirectListRouter());

  // ---- 1688 Plugin data receiver ----
  const { createPluginRouter } = await import("./plugin.route.js");
  mountApi("", createPluginRouter());

  // ---- Image upload (file upload + optimize) ----
  const { createImageUploadRouter } = await import("./image-upload.route.js");
  mountApi("", createImageUploadRouter());

  // ---- Material routes (plugin download progress + WebSocket) ----
  const { createMaterialRouter } = await import("./material.route.js");
  mountApi("", createMaterialRouter());

  // ---- Product Selection Lists ----
  const { createSelectionRouter } = await import("./selection.route.js");
  mountApi("", createSelectionRouter());

  // ---- Task scheduler routes ----
  const { createTaskTriggerRouter } = await import("./task.route.js");
  app.use("/api/task", createTaskTriggerRouter());
  app.use("/api/v1/task", createTaskTriggerRouter());

  // ---- Task monitor routes (queue stats, failed tasks, dead-letter retry, listings) ----
  const { createTaskMonitorRouter } = await import("./task-monitor.route.js");
  const taskMonitorRouter = createTaskMonitorRouter(taskQueue);
  app.use("/api/task", taskMonitorRouter);
  app.use("/api/v1/task", taskMonitorRouter);
}
