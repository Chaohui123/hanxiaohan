// ============================================================
// Environment configuration — unified .env reader
// All keys, URLs, model names, concurrency params read from .env
// ============================================================

import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Always load .env from project root regardless of CWD
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");
const result = dotenv.config({ path: resolve(projectRoot, ".env") });
if (result.error) console.error("[Config] Failed to load .env:", result.error.message);

export interface AppConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  databaseUrl: string;
  maxAiConcurrency: number;
  maxTaskConcurrency: number;

  ozon: {
    clientId: string;
    apiKey: string;
    baseUrl: string;
  };

  kimi: {
    apiKey: string;
    baseUrl: string;
    visionModel: string;
  };

  deepseek: {
    apiKey: string;
    baseUrl: string;
    flashModel: string;
    proModel: string;
  };

  scraper: {
    maxBrowserPool: number;
    requestDelayMin: number;
    requestDelayMax: number;
  };

  orderSyncPageSize: number;

  autoPublish: {
    /** AUTO_PUBLISH_ENABLED — master switch for the auto-publish-queue job (default true) */
    enabled: boolean;
    /** AUTO_PUBLISH_INTERVAL_MIN — job interval in minutes (default 10) */
    intervalMin: number;
    /** AUTO_PUBLISH_BATCH_SIZE — listing tasks dequeued per run (default 5) */
    batchSize: number;
  };

  deadletterAutoRetry: {
    /** DEADLETTER_AUTO_RETRY_ENABLED — master switch for the deadletter-auto-retry job (default true) */
    enabled: boolean;
    /** DEADLETTER_RETRY_INTERVAL_MIN — job interval in minutes (default 30) */
    intervalMin: number;
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.startsWith("your_") || value.startsWith("YOUR_") || value.startsWith("CHANGE_ME")) {
    throw new Error(`Missing or placeholder environment variable: ${key}. Set it in .env`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value && !value.startsWith("your_") ? value : fallback;
}

export function loadConfig(): AppConfig {
  // Production safety: ENCRYPTION_KEY is mandatory
  const isProduction = (process.env.ENV || process.env.NODE_ENV) === "production";
  if (isProduction) {
    requireEnv("ENCRYPTION_KEY");
    const encKey = process.env.ENCRYPTION_KEY!;
    if (encKey.length < 32) {
      throw new Error("ENCRYPTION_KEY must be at least 32 characters in production");
    }
  }

  return {
    port: parseInt(optionalEnv("API_SERVICE_PORT", "3000"), 10),
    nodeEnv: optionalEnv("NODE_ENV", "development"),
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    databaseUrl: optionalEnv("DATABASE_URL", "postgresql://onzo:onzo@localhost:5432/onzo_prod"),
    maxAiConcurrency: parseInt(optionalEnv("MAX_AI_CONCURRENCY", "10"), 10),
    maxTaskConcurrency: parseInt(optionalEnv("MAX_TASK_CONCURRENCY", "5"), 10),

    ozon: {
      clientId: requireEnv("OZON_CLIENT_IDS"),
      apiKey: requireEnv("OZON_API_KEYS"),
      baseUrl: optionalEnv("OZON_API_BASE", "https://api.ozon.ru/v3"),
    },

    kimi: {
      apiKey: requireEnv("KIMI_API_KEY"),
      baseUrl: optionalEnv("KIMI_BASE_URL", "https://api.moonshot.cn/v1"),
      visionModel: optionalEnv("KIMI_VISION_MODEL", "kimi-k3"),
    },

    deepseek: {
      apiKey: requireEnv("DEEPSEEK_API_KEY"),
      baseUrl: optionalEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
      flashModel: optionalEnv("DEEPSEEK_FLASH_MODEL", "deepseek-v4-flash"),
      proModel: optionalEnv("DEEPSEEK_PRO_MODEL", "deepseek-v4-pro"),
    },

    scraper: {
      maxBrowserPool: parseInt(optionalEnv("SCRAPER_MAX_BROWSER_POOL", "3"), 10),
      // Enforce a hard minimum of 3000ms to avoid 1688 anti-bot triggers
      requestDelayMin: Math.max(3000, parseInt(optionalEnv("SCRAPER_REQUEST_DELAY_MIN", "3000"), 10)),
      requestDelayMax: Math.max(5000, parseInt(optionalEnv("SCRAPER_REQUEST_DELAY_MAX", "5000"), 10)),
    },
    orderSyncPageSize: parseInt(optionalEnv("ORDER_SYNC_PAGE_SIZE", "50"), 10),

    autoPublish: {
      enabled: optionalEnv("AUTO_PUBLISH_ENABLED", "true") !== "false",
      intervalMin: Math.max(1, parseInt(optionalEnv("AUTO_PUBLISH_INTERVAL_MIN", "10"), 10)),
      batchSize: Math.max(1, parseInt(optionalEnv("AUTO_PUBLISH_BATCH_SIZE", "5"), 10)),
    },

    deadletterAutoRetry: {
      enabled: optionalEnv("DEADLETTER_AUTO_RETRY_ENABLED", "true") !== "false",
      intervalMin: Math.max(1, parseInt(optionalEnv("DEADLETTER_RETRY_INTERVAL_MIN", "30"), 10)),
    },
  };
}