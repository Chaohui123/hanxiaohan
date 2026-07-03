// packages/ai/src/config.ts
// Central config reader for AI model keys, URLs, and limits.
// All values sourced from project root .env via dotenv.
import dotenv from "dotenv";
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.startsWith("your_")) {
    throw new Error(`Missing or placeholder environment variable: ${key}`);
  }
  return value;
}

/** GLM vision model — fixed OCR pipeline (glm-4.6v-flash) */
export const GLM_CONFIG = {
  apiKey: requireEnv("GLM_API_KEY"),
  baseUrl: process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
  model: process.env.GLM_VISION_MODEL || "glm-4.6v-flash",
};

/** DeepSeek text models — tiered by task complexity */
export const DEEPSEEK_CONFIG = {
  apiKey: requireEnv("DEEPSEEK_API_KEY"),
  baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
  flashModel: process.env.DEEPSEEK_FLASH_MODEL || "deepseek-v4-flash",
  proModel: process.env.DEEPSEEK_PRO_MODEL || "deepseek-v4-pro",
};

/** Global AI concurrency cap */
export const AI_LIMIT = {
  maxConcurrency: Number(process.env.MAX_AI_CONCURRENCY || 10),
};

/**
 * Route text model based on task complexity.
 * @param isComplexCompare — true for multi-competitor deep analysis (P2)
 */
export function getTextLLMConfig(isComplexCompare: boolean) {
  return {
    apiKey: DEEPSEEK_CONFIG.apiKey,
    baseUrl: DEEPSEEK_CONFIG.baseUrl,
    model: isComplexCompare
      ? DEEPSEEK_CONFIG.proModel
      : DEEPSEEK_CONFIG.flashModel,
  };
}
