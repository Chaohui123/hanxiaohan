// ============================================================
// Diagnostic endpoint — GET /api/diagnose
// One-click health check: DB, Redis, Ozon, backup, scheduler, dead-letter
// ============================================================

import { Router } from "express";
import { statfs, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db/connection.js";
import { getJobsStatus, type JobStatus } from "../services/scheduler.js";
import { checkPipelineHealth } from "../pipelines/pipeline-health.js";
import type { OzonClient } from "@onzo/ozon-api-wrapper";

interface CheckResult {
  status: "ok" | "degraded" | "unavailable" | "error";
  message?: string;
  latencyMs?: number;
}

interface DiagnoseResponse {
  status: "healthy" | "degraded" | "unhealthy";
  checks: Record<string, CheckResult>;
  scheduler: JobStatus[];
  backup: {
    lastBackupAt: string | null;
    ageHours: number | null;
    status: "ok" | "degraded" | "unavailable";
  };
  deadLetterCount: number;
  timestamp: string;
}

export function createDiagnoseRouter(ozonClient?: OzonClient): Router {
  const router = Router();

  router.get("/diagnose", async (_req, res) => {
    const checks: Record<string, CheckResult> = {};
    const startedAt = Date.now();

    // ---- 1. DB writability (SELECT + INSERT + DELETE) ----
    const dbStart = Date.now();
    try {
      const db = await getDb();
      if (db) {
        await db.all("SELECT 1");
        await db.run(
          "CREATE TABLE IF NOT EXISTS health_checks (id SERIAL PRIMARY KEY, checked_at TIMESTAMP DEFAULT NOW())"
        );
        await db.run("INSERT INTO health_checks DEFAULT VALUES");
        await db.run("DELETE FROM health_checks");
        checks.db = { status: "ok", latencyMs: Date.now() - dbStart };
      } else {
        checks.db = { status: "unavailable", message: "DB pool is null" };
      }
    } catch (err) {
      checks.db = { status: "error", message: (err as Error).message, latencyMs: Date.now() - dbStart };
    }

    // ---- 2. Redis connectivity ----
    const redisStart = Date.now();
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl && !redisUrl.includes("CHANGE_ME")) {
      try {
        const { cache } = await import("@onzo/cache");
        const hc = await cache.healthCheck();
        checks.redis = hc.available
          ? { status: "ok", latencyMs: hc.latencyMs }
          : { status: "degraded", message: "Redis ping failed" };
      } catch (err) {
        checks.redis = { status: "error", message: (err as Error).message };
      }
    } else {
      checks.redis = { status: "unavailable", message: "REDIS_URL not configured" };
    }

    // ---- 3. Ozon API ----
    const ozonStart = Date.now();
    if (ozonClient) {
      try {
        const ok = await Promise.race([
          ozonClient.ping(),
          new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
        ]);
        checks.ozonApi = ok
          ? { status: "ok", latencyMs: Date.now() - ozonStart }
          : { status: "degraded", message: "Ozon ping returned false" };
      } catch (err) {
        checks.ozonApi = { status: "error", message: (err as Error).message };
      }
    } else {
      checks.ozonApi = { status: "unavailable", message: "OzonClient not initialized" };
    }

    // ---- 4. External dependency depth check ----
    try {
      const ph = await checkPipelineHealth();
      const failed = ph.components.filter((c) => c.status === "down");
      checks.externalDeps = {
        status: failed.length === 0 ? "ok" : failed.length <= 1 ? "degraded" : "error",
        message: ph.components.map((c) => `${c.name}:${c.status}`).join(", "),
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      checks.externalDeps = { status: "error", message: (err as Error).message };
    }

    // ---- 5. Webhook reachability ----
    const publicDomain = process.env.PUBLIC_DOMAIN;
    if (publicDomain && !publicDomain.includes("CHANGE_ME")) {
      const whStart = Date.now();
      try {
        const resp = await fetch(`https://${publicDomain}/health`, {
          signal: AbortSignal.timeout(10_000),
        });
        checks.webhookReachable = resp.ok
          ? { status: "ok", latencyMs: Date.now() - whStart }
          : { status: "degraded", message: `HTTP ${resp.status}`, latencyMs: Date.now() - whStart };
      } catch (err) {
        checks.webhookReachable = {
          status: "error",
          message: (err as Error).message,
          latencyMs: Date.now() - whStart,
        };
      }
    } else {
      checks.webhookReachable = { status: "unavailable", message: "PUBLIC_DOMAIN not configured" };
    }

    // ---- 6. Disk space ----
    try {
      const dirs = [process.env.BACKUP_DIR || "./data/backups", "./data"];
      const msgs: string[] = [];
      for (const dir of dirs) {
        try {
          const s = await statfs(dir);
          const freeMb = (s.bfree * s.bsize) / (1024 * 1024);
          msgs.push(`${dir}:${freeMb.toFixed(0)}MB`);
        } catch {
          msgs.push(`${dir}:inaccessible`);
        }
      }
      checks.disk = { status: "ok", message: msgs.join("; ") };
    } catch (err) {
      checks.disk = { status: "error", message: (err as Error).message };
    }

    // ---- 7. Backup status ----
    const backupDir = process.env.BACKUP_DIR || "./data/backups";
    const backupIntervalHours = parseInt(process.env.BACKUP_INTERVAL_HOURS || "6", 10);
    let lastBackupAt: string | null = null;
    let ageHours: number | null = null;
    let backupStatus: "ok" | "degraded" | "unavailable" = "unavailable";

    try {
      const files = await readdir(backupDir).catch(() => [] as string[]);
      const backups = files
        .filter((f) => f.startsWith("onzo-") && (f.endsWith(".sql.gz") || f.endsWith(".sql.gz.enc")))
        .sort()
        .reverse();

      if (backups.length > 0) {
        const latest = await stat(join(backupDir, backups[0])).catch(() => null);
        if (latest) {
          lastBackupAt = latest.mtime.toISOString();
          ageHours = (Date.now() - latest.mtimeMs) / 3600_000;
          backupStatus = ageHours <= backupIntervalHours * 2 ? "ok" : "degraded";
        }
      }
    } catch {
      backupStatus = "unavailable";
    }

    // ---- 8. Dead letter queue ----
    let deadLetterCount = 0;
    try {
      const dlDir = process.env.DEAD_LETTER_DIR || "./dead-letter";
      const dlFiles = await readdir(dlDir).catch(() => [] as string[]);
      deadLetterCount = dlFiles.length;
    } catch {
      deadLetterCount = -1;
    }

    // ---- 9. Scheduler status ----
    const scheduler = getJobsStatus();

    // ---- Aggregate ----
    const allChecks = Object.values(checks).every(
      (c) => c.status === "ok" || c.status === "degraded"
    );
    const anyError = Object.values(checks).some((c) => c.status === "error" || c.status === "unavailable");

    const response: DiagnoseResponse = {
      status: anyError ? "unhealthy" : allChecks ? "healthy" : "degraded",
      checks,
      scheduler,
      backup: { lastBackupAt, ageHours, status: backupStatus },
      deadLetterCount,
      timestamp: new Date().toISOString(),
    };

    res.status(response.status === "unhealthy" ? 503 : 200).json(response);
  });

  return router;
}
