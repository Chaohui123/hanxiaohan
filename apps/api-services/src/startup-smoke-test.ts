// ============================================================
// Startup Smoke Tests — runs once after server.listen()
// Verifies critical dependencies before the service accepts traffic.
// Failures are logged but do NOT block startup (except DB write).
// ============================================================

import { logger } from "@onzo/logger";
import { getDb } from "./db/connection.js";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { OzonClient } from "@onzo/ozon-api-wrapper";

interface SmokeResult {
  check: string;
  status: "ok" | "fail";
  latencyMs: number;
  message?: string;
}

const results: SmokeResult[] = [];

function record(check: string, status: "ok" | "fail", latencyMs: number, message?: string): void {
  results.push({ check, status, latencyMs, message });
  logger.info({ type: "smoke_test", check, status, latencyMs, ...(message ? { message } : {}) });
}

export async function runSmokeTests(ozonClient: OzonClient): Promise<SmokeResult[]> {
  results.length = 0;
  logger.info({ type: "smoke_test", event: "starting" }, "Running startup smoke tests...");

  // ---- 1. DB read/write ----
  const dbStart = Date.now();
  try {
    const db = await getDb();
    if (db) {
      await db.run(
        "CREATE TABLE IF NOT EXISTS health_checks (check_name TEXT PRIMARY KEY, status TEXT, checked_at TIMESTAMP DEFAULT NOW())"
      );
      await db.run("INSERT INTO health_checks (check_name, status) VALUES ('smoke', 'ok') ON CONFLICT(check_name) DO UPDATE SET status='ok', checked_at=NOW()");
      await db.run("DELETE FROM health_checks WHERE check_name = 'smoke'");
      record("db_write", "ok", Date.now() - dbStart);
    } else {
      record("db_write", "fail", Date.now() - dbStart, "DB pool is null — check DATABASE_URL");
    }
  } catch (err) {
    record("db_write", "fail", Date.now() - dbStart, (err as Error).message);
    const { emitEvent } = await import("./services/notification-events.js");
    emitEvent("CIRCUIT_BREAKER_OPEN", {
      service: "db-write",
      failures: "smoke-test-failed",
    }).catch(() => {});
  }

  // ---- 2. Ozon API Key validity ----
  const ozonStart = Date.now();
  try {
    const ok = await ozonClient.ping();
    record("ozon_api", ok ? "ok" : "fail", Date.now() - ozonStart, ok ? undefined : "Ozon ping returned false");
  } catch (err) {
    record("ozon_api", "fail", Date.now() - ozonStart, (err as Error).message);
    logger.error({ err: (err as Error).message }, "Ozon API ping failed — service will continue with degraded Ozon features");
  }

  // ---- 3. Redis availability ----
  const redisStart = Date.now();
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl && !redisUrl.includes("CHANGE_ME")) {
    try {
      const { cache } = await import("@onzo/cache");
      const hc = await cache.healthCheck();
      record("redis", hc.available ? "ok" : "fail", Date.now() - redisStart, hc.available ? undefined : "Ping failed");
    } catch (err) {
      record("redis", "fail", Date.now() - redisStart, (err as Error).message);
    }
  } else {
    record("redis", "ok", 0, "not configured — skipped");
  }

  // ---- 4. Kimi K3 vision API key validity ----
  const kimiStart = Date.now();
  const kimiKey = process.env.KIMI_API_KEY;
  if (kimiKey && !kimiKey.includes("CHANGE_ME")) {
    try {
      const kimiBase = process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1";
      const kimiModel = process.env.KIMI_VISION_MODEL || "kimi-k3";
      const resp = await fetch(`${kimiBase}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${kimiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: kimiModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(10_000),
      });
      record("kimi_api", resp.ok || resp.status === 429 ? "ok" : "fail", Date.now() - kimiStart,
        resp.status === 429 ? "Rate limited but reachable" : resp.ok ? undefined : `HTTP ${resp.status}`);
    } catch (err) {
      record("kimi_api", "fail", Date.now() - kimiStart, (err as Error).message);
    }
  } else {
    record("kimi_api", "fail", 0, "KIMI_API_KEY not configured");
  }

  // ---- 5. DeepSeek API Key validity ----
  const dsStart = Date.now();
  const dsKey = process.env.DEEPSEEK_API_KEY;
  if (dsKey && !dsKey.includes("CHANGE_ME")) {
    try {
      const resp = await fetch("https://api.deepseek.com/v1/models", {
        headers: { "Authorization": `Bearer ${dsKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      record("deepseek_api", resp.ok ? "ok" : "fail", Date.now() - dsStart,
        resp.ok ? undefined : `HTTP ${resp.status}`);
    } catch (err) {
      record("deepseek_api", "fail", Date.now() - dsStart, (err as Error).message);
    }
  } else {
    record("deepseek_api", "fail", 0, "DEEPSEEK_API_KEY not configured");
  }

  // ---- 6. Backup directory writability ----
  const backupStart = Date.now();
  try {
    const backupDir = process.env.BACKUP_DIR || "./data/backups";
    await mkdir(backupDir, { recursive: true });
    const testFile = join(backupDir, ".smoke-test");
    await writeFile(testFile, "smoke");
    await unlink(testFile);
    record("backup_dir", "ok", Date.now() - backupStart);
  } catch (err) {
    record("backup_dir", "fail", Date.now() - backupStart, (err as Error).message);
  }

  // ---- Summary ----
  const failed = results.filter((r) => r.status === "fail");
  const criticalFail = results.find((r) => r.check === "db_write" && r.status === "fail");

  logger.info({
    type: "smoke_test",
    event: "complete",
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    critical: !!criticalFail,
  }, criticalFail ? "SMOKE TEST FAILED — critical dependency down" : "Smoke tests passed");

  return results;
}
