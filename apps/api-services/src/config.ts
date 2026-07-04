// ============================================================
// Environment configuration — unified .env reader
// All keys, URLs, model names, concurrency params read from .env
// ============================================================

import "dotenv/config";

export interface AppConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  dbPath: string;
  maxAiConcurrency: number;

  ozon: {
    clientId: string;
    apiKey: string;
    baseUrl: string;
  };

  glm: {
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
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.startsWith("your_")) {
    throw new Error(`Missing or placeholder environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value && !value.startsWith("your_") ? value : fallback;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(optionalEnv("API_SERVICE_PORT", "3000"), 10),
    nodeEnv: optionalEnv("NODE_ENV", "development"),
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    dbPath: optionalEnv("SQLITE_DB_PATH", "./data/onzo.db"),
    maxAiConcurrency: parseInt(optionalEnv("MAX_AI_CONCURRENCY", "10"), 10),

    ozon: {
      clientId: requireEnv("OZON_CLIENT_IDS"),
      apiKey: requireEnv("OZON_API_KEYS"),
      baseUrl: optionalEnv("OZON_API_BASE", "https://api.ozon.ru/v3"),
    },

    glm: {
      apiKey: requireEnv("GLM_API_KEY"),
      baseUrl: optionalEnv("GLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),
      visionModel: optionalEnv("GLM_VISION_MODEL", "glm-4.6v-flash"),
    },

    deepseek: {
      apiKey: requireEnv("DEEPSEEK_API_KEY"),
      baseUrl: optionalEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
      flashModel: optionalEnv("DEEPSEEK_FLASH_MODEL", "deepseek-v4-flash"),
      proModel: optionalEnv("DEEPSEEK_PRO_MODEL", "deepseek-v4-pro"),
    },

    scraper: {
      maxBrowserPool: parseInt(optionalEnv("SCRAPER_MAX_BROWSER_POOL", "3"), 10),
      requestDelayMin: parseInt(optionalEnv("SCRAPER_REQUEST_DELAY_MIN", "800"), 10),
      requestDelayMax: parseInt(optionalEnv("SCRAPER_REQUEST_DELAY_MAX", "1500"), 10),
    },
    orderSyncPageSize: parseInt(optionalEnv("ORDER_SYNC_PAGE_SIZE", "50"), 10),
  };
}
