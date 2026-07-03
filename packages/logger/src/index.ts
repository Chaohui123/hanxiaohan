// ============================================================
// @onzo/logger — Unified structured logging via Pino
// All project modules import from here per rules.md
// ============================================================

import pino from "pino";

export interface LoggerConfig {
  level?: string;
  name?: string;
}

export function createLogger(config?: LoggerConfig) {
  return pino({
    level: config?.level ?? (process.env.LOG_LEVEL || "info"),
    name: config?.name ?? "onzo",
  });
}

export type Logger = ReturnType<typeof createLogger>;

/** Default singleton logger for quick imports */
export const logger = createLogger();
