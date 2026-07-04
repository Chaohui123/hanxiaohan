// ============================================================
// Pino structured JSON logger with file persistence
// Stdout + daily rotating file in ./logs/
// ============================================================

import pino from "pino";
import { createWriteStream, mkdirSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";

// Track current log file date for daily rotation
let currentLogDate = "";
let logStream: ReturnType<typeof createWriteStream> | null = null;
const LOG_DIR = process.env.LOG_DIR || "./logs";

function getLogFilePath(): string {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
  return join(LOG_DIR, `onzo-${dateStr}.log`);
}

function rotateLogIfNeeded(): void {
  const today = new Date().toISOString().split("T")[0];
  if (today === currentLogDate && logStream) return;

  // Close previous stream
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  // Ensure log directory exists
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }

  // Create new stream for today
  const filePath = getLogFilePath();
  logStream = createWriteStream(filePath, { flags: "a" });
  currentLogDate = today;

  console.log(`[Logger] Writing logs to ${filePath}`);
}

/**
 * A simple writable stream that delegates to the rotating file stream.
 */
function createRotatingStream() {
  rotateLogIfNeeded();

  return new pino.destination({
    write(chunk: string) {
      rotateLogIfNeeded();
      if (logStream) {
        logStream.write(chunk);
      }
    },
  });
}

export function createLogger(config: AppConfig) {
  const streams: pino.StreamEntry[] = [
    // Always log to stdout
    { stream: process.stdout },
  ];

  // Also log to rotating file in production
  if (config.nodeEnv !== "test") {
    try {
      rotateLogIfNeeded();
      streams.push({ stream: createRotatingStream() });
    } catch {
      console.warn("[Logger] Failed to create log file stream — logging to stdout only");
    }
  }

  return pino(
    {
      level: config.logLevel,
    },
    pino.multistream(streams)
  );
}

export type Logger = ReturnType<typeof createLogger>;
