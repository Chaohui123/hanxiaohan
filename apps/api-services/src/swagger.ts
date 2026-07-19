// ============================================================
// OpenAPI 3.0 Specification for ONZO API
// Served at /api/docs via swagger-ui-express
// ============================================================

export const swaggerSpec = {
  openapi: "3.0.3",
  info: {
    title: "ONZO — Ozon Cross-Border E-Commerce Automation API",
    version: "1.0.0",
    description: "Phase 1+2: 1688→Ozon product listing, order sync, inventory management",
  },
  servers: [{ url: "http://localhost:3000", description: "Local dev" }],
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        responses: { "200": { description: "OK", content: { "application/json": { example: { status: "ok", uptime: 123, timestamp: "2026-07-03T00:00:00Z" } } } } },
      },
    },
    "/api/dashboard": {
      get: {
        summary: "Ops dashboard — queue, tokens, orders, stock",
        responses: { "200": { description: "Dashboard JSON" } },
      },
    },
    "/api/stats/llm": {
      get: {
        summary: "LLM token consumption (daily aggregations)",
        responses: { "200": { description: "Array of daily token records" } },
      },
    },
    "/api/process/manual": {
      post: {
        summary: "Manual listing — JSON input → Ozon draft",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["title", "priceCny", "specImages"], properties: { title: { type: "string" }, priceCny: { type: "number" }, specImages: { type: "array", items: { type: "string" } }, specifications: { type: "array" }, descriptionText: { type: "string" } } } } },
        },
        responses: {
          "200": { description: "Draft created" },
          "422": { description: "Validation failed" },
        },
      },
    },
    "/api/process/sync": {
      post: {
        summary: "Sync listing — 1688 URL → Ozon draft (with scraper)",
        requestBody: { content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", example: "https://detail.1688.com/offer/xxxxx.html" } } } } } },
        responses: { "200": { description: "Draft created" } },
      },
    },
    "/api/bulk/import": {
      post: {
        summary: "Bulk import — up to 100 products",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { products: { type: "array", items: { type: "object" } } } } } } },
        responses: { "202": { description: "Queued for processing" } },
      },
    },
    "/api/orders": {
      get: {
        summary: "List synced orders (optional ?status=delivering)",
        parameters: [{ name: "status", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "Array of orders" } },
      },
    },
    "/api/orders/sync": {
      post: {
        summary: "Pull orders from Ozon (FBS+FBO) and store locally",
        responses: { "200": { description: "Sync result with counts" } },
      },
    },
    "/api/orders/ship": {
      post: {
        summary: "Mark FBS order as shipped with tracking number",
        requestBody: { content: { "application/json": { schema: { type: "object", required: ["postingNumber", "trackingNumber", "products"], properties: { postingNumber: { type: "string" }, trackingNumber: { type: "string" }, products: { type: "array" } } } } } },
        responses: { "200": { description: "Shipped" } },
      },
    },
    "/api/webhook/ozon": {
      post: {
        summary: "Ozon push notification receiver (HMAC-SHA256 verified)",
        parameters: [{ name: "X-Ozon-Signature", in: "header", schema: { type: "string" } }],
        responses: { "200": { description: "Processed" } },
      },
    },
    "/api/task/queue/stats": {
      get: { summary: "Task queue statistics", responses: { "200": { description: "Queue stats JSON" } } },
    },
    "/api/task/queue": {
      get: {
        summary: "List queued tasks (optional ?status=&storeId=&type=&limit=)",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["all", "queued", "processing", "done", "failed"] } },
          { name: "storeId", in: "query", schema: { type: "string" } },
          { name: "type", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 500 } },
        ],
        responses: { "200": { description: "Array of tasks" } },
      },
    },
    "/api/task/failed": {
      get: {
        summary: "List failed tasks (dead letter queue; ?status=&storeId=&limit=)",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["actionable", "pending_retry", "retrying", "permanent_failure", "retried", "all"], default: "actionable" } },
          { name: "storeId", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 500 } },
        ],
        responses: { "200": { description: "Array of failed tasks" } },
      },
      post: {
        summary: "Record an external failure notification into the dead letter queue (n8n)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["error"], properties: { error: { oneOf: [{ type: "string" }, { type: "object" }] }, source: { type: "string" }, taskType: { type: "string" }, storeId: { type: "string" } } } } },
        },
        responses: { "201": { description: "Dead letter entry created" }, "400": { description: "Validation failed" } },
      },
    },
    "/api/task/retry/{id}": {
      post: {
        summary: "Re-queue a single task by id (task_queue or failed_tasks)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Task re-queued" },
          "400": { description: "Task not retryable" },
          "404": { description: "Task not found" },
        },
      },
    },
    "/api/task/deadletter/retry-batch": {
      post: {
        summary: "Batch retry failed tasks (by taskIds, or by filterType category)",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { taskIds: { type: "array", items: { type: "string" } }, filterType: { type: "string", enum: ["all", "all_retryable", "api_error", "validation", "network", "rate_limit", "circuit_breaker", "unknown"] }, storeId: { type: "string" }, limit: { type: "integer", default: 50 } } } } } },
        responses: { "200": { description: "Retry results { retried, failed, total }" } },
      },
    },
    "/api/db/backup": {
      post: {
        summary: "Trigger SQLite backup (7-day rotation)",
        responses: { "200": { description: "Backup file name + retained count" } },
      },
    },
    "/api/task/listings": {
      get: {
        summary: "Listing history (optional ?status=&limit=)",
        parameters: [
          { name: "status", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 200 } },
        ],
        responses: { "200": { description: "Array of listing records" } },
      },
      post: { summary: "Listing history (POST alias for n8n auto-publish workflow)", responses: { "200": { description: "Array of listing records" } } },
    },
  },
};
