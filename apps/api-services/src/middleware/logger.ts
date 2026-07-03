// ============================================================
// Pino structured JSON logger
// ============================================================

import pino from "pino";
import type { AppConfig } from "../config.js";

export function createLogger(config: AppConfig) {
  return pino({
    level: config.logLevel,
  });
}

export type Logger = ReturnType<typeof createLogger>;
