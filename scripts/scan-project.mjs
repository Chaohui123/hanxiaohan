import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

function readSummary(p, lines) {
  try { return readFileSync(p, "utf8").split("\n").slice(0, lines).join("\n"); }
  catch { return "NOT FOUND"; }
}

function tree(dir, depth = 0) {
  if (depth > 3) return "...";
  const t = {};
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      t[e.name + (e.isDirectory() ? "/" : "")] = e.isDirectory() ? tree(full, depth + 1) : null;
    }
  } catch {}
  return t;
}

const result = {
  scannedAt: new Date().toISOString(),

  packageJsonFiles: [
    { path: "package.json", name: "onzo", role: "root workspace", deps: ["express", "pino", "sharp", "zod"] },
    { path: "apps/api-services/package.json", name: "@onzo/api-services", role: "Express server", deps: ["drizzle-orm", "cos-nodejs-sdk-v5", "xlsx"] },
    { path: "packages/ai/package.json", name: "@onzo/glm-integration", role: "AI client wrapper" },
    { path: "packages/ozon-api-wrapper/package.json", name: "@onzo/ozon-api-wrapper", role: "Ozon SDK" },
    { path: "packages/ozon-order/package.json", name: "@onzo/ozon-order", role: "Order sync + inventory + webhook" },
    { path: "packages/scraper/package.json", name: "@onzo/scraper-1688", role: "1688 Playwright scraper" },
    { path: "packages/validator/package.json", name: "@onzo/validation-layer", role: "Product validation" },
    { path: "packages/shared-types/package.json", name: "@onzo/shared-types", role: "Shared TypeScript types" },
    { path: "packages/logger/package.json", name: "@onzo/logger", role: "Pino logger" },
    { path: "packages/price-monitor/package.json", name: "@onzo/price-monitor", role: "Price scanner + scorer" },
  ],

  srcFileTree: {
    "apps/api-services/src": tree("apps/api-services/src"),
    "packages": tree("packages"),
  },

  databaseConfig: {
    orm: "Drizzle ORM v0.45.2",
    dialect: "postgresql",
    driver: "node-postgres (pg) Pool",
    configFile: "drizzle.config.ts",
    tables: [
      "task_queue", "failed_tasks", "listing_records", "price_history",
      "local_orders", "webhook_events", "inventory", "stock_movements",
      "token_usage", "store_configs", "category_cache", "_migrations",
    ],
    migrationSystem: {
      runner: "db/migrate.ts",
      migrations: "db/migrations.ts",
      tracking: "_migrations table",
      currentVersion: 1,
    },
    transactionLayer: "db/transaction.ts",
    keyFiles: {
      schema: readSummary("apps/api-services/src/db/schema.ts", 20),
      connection: readSummary("apps/api-services/src/db/connection.ts", 25),
      transaction: readSummary("apps/api-services/src/db/transaction.ts", 20),
    },
  },

  taskQueue: {
    primary: {
      file: "db/task-queue.ts",
      type: "In-memory Map + SQLite dual queue",
      features: ["enqueue", "dequeueBatch", "markDone", "markFailed", "retry", "getStats", "prune", "stuck-recovery"],
      taskTypes: ["listing", "ocr", "translate", "upload_image", "create_draft", "batch_listing"],
    },
    asyncQueues: {
      file: "services/async-queue.ts",
      instances: {
        cosUploadQueue: { concurrency: 5, retries: 2 },
        ffmpegQueue: { concurrency: 1, retries: 1 },
        deadLetterQueue: { concurrency: 3, retries: 3 },
      },
    },
    deadLetter: {
      file: "services/dead-letter.ts",
      categories: ["api_error", "validation", "network", "rate_limit", "circuit_breaker", "unknown"],
      storage: "failed_tasks PostgreSQL table",
    },
  },

  errorHandling: {
    layers: [
      { layer: 1, name: "Ozon API Error Classes", file: "packages/ozon-api-wrapper/src/errors.ts" },
      { layer: 2, name: "Circuit Breaker", file: "packages/ozon-api-wrapper/src/circuit-breaker.ts" },
      { layer: 3, name: "Retry Policy", file: "packages/ozon-api-wrapper/src/retry.ts" },
      { layer: 4, name: "Fallback Handler", file: "packages/ozon-api-wrapper/src/fallback.ts" },
      { layer: 5, name: "Express Error Handler", file: "apps/api-services/src/middleware/error-handler.ts" },
      { layer: 6, name: "App Error Classes", file: "apps/api-services/src/errors/index.ts" },
      { layer: 7, name: "Dead Letter Queue", file: "apps/api-services/src/services/dead-letter.ts" },
    ],
  },
};

process.stdout.write(JSON.stringify(result, null, 2));
