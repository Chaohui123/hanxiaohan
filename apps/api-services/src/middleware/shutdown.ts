// ============================================================
// Graceful Shutdown — shared cleanup registry
// Imported by index.ts and any module that needs cleanup hooks
// ============================================================

import { logger } from "@onzo/logger";

const cleanupFns: Array<() => Promise<void>> = [];

export function registerCleanup(fn: () => Promise<void>): void {
  cleanupFns.push(fn);
}

export async function runCleanup(): Promise<void> {
  for (const fn of cleanupFns) {
    try {
      await fn();
    } catch (err) {
      logger.error({ err }, "Cleanup hook failed");
    }
  }
}

export function setupShutdownHandlers(server: { close: () => void }, logger: { info: (msg: string) => void; error: (obj: unknown, msg: string) => void }): void {
  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal} — shutting down gracefully...`);

    // 1. Stop accepting new connections
    server.close();
    logger.info("HTTP server closed");

    // 2. Wait for in-flight requests (max 5s)
    await new Promise((r) => setTimeout(r, 5000));

    // 3. Run registered cleanup hooks
    await runCleanup();

    logger.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
