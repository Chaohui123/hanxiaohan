// ============================================================
// Health check routes — liveness, readiness, pipeline deep-check
// ============================================================

import { Router } from "express";
import { statfs } from "node:fs/promises";
import { getDb } from "../db/connection.js";
import { checkPipelineHealth } from "../pipelines/pipeline-health.js";
import type { OzonClient } from "@onzo/ozon-api-wrapper";

interface HealthDetail {
  status: "ok" | "degraded" | "unavailable" | "error";
  message?: string;
  latencyMs?: number;
}

type HealthChecks = Record<string, HealthDetail | Record<string, HealthDetail>>;

export function createHealthRouter(ozonClient?: OzonClient): Router {
  const router = Router();

  // GET /health — liveness (lightweight: process + fast DB ping, for Docker healthcheck)
  router.get("/health", async (_req, res) => {
    // Fast DB ping — fail open (2s timeout) to avoid cascading restarts
    let dbOk = true;
    try {
      const db = await Promise.race([
        getDb(),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_000)),
      ]);
      if (db) {
        await Promise.race([
          db.all("SELECT 1"),
          new Promise<[]>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1_000)),
        ]);
      }
    } catch {
      dbOk = false; // degraded but not dead — don't restart container for DB issues
    }

    res.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      dbConnected: dbOk,
    });
  });

  // GET /ready/pipeline — deep pipeline health (all external deps)
  router.get("/ready/pipeline", async (_req, res) => {
    try {
      const health = await checkPipelineHealth();
      res.json(health);
    } catch (err) {
      res.status(500).json({ status: "unhealthy", error: (err as Error).message });
    }
  });

  // GET /ready — comprehensive readiness (DB + Ozon API + Redis + Disk + Model keys)
  router.get("/ready", async (_req, res) => {
    const checks: HealthChecks = {};
    const startedAt = Date.now();

    // 1. Database
    const dbStart = Date.now();
    try {
      const db = await getDb();
      if (db) {
        await db.all("SELECT 1");
        checks.db = { status: "ok", latencyMs: Date.now() - dbStart };
      } else {
        checks.db = { status: "unavailable", message: "DB pool is null — check DATABASE_URL" };
      }
    } catch (err) {
      checks.db = { status: "error", message: (err as Error).message, latencyMs: Date.now() - dbStart };
    }

    // 2. Ozon API connectivity — use client's ping (through circuit breaker + auth)
    const ozonStart = Date.now();
    if (ozonClient) {
      try {
        const ok = await Promise.race([
          ozonClient.ping(),
          new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
        ]);
        checks.ozonApi = ok
          ? { status: "ok", latencyMs: Date.now() - ozonStart }
          : { status: "degraded", message: "Ozon API ping returned false", latencyMs: Date.now() - ozonStart };
      } catch (err) {
        checks.ozonApi = { status: "error", message: (err as Error).message, latencyMs: Date.now() - ozonStart };
      }
    } else {
      // Fallback: raw fetch with env vars
      try {
        const resp = await fetch("https://api-seller.ozon.ru/v1/warehouse/list", {
          method: "POST",
          headers: {
            "Client-Id": process.env.OZON_CLIENT_IDS || "",
            "Api-Key": process.env.OZON_API_KEYS || "",
            "Content-Type": "application/json",
          },
          body: "{}",
          signal: AbortSignal.timeout(10_000),
        });
        checks.ozonApi = resp.ok || resp.status === 400
          ? { status: "ok", latencyMs: Date.now() - ozonStart }
          : { status: "degraded", message: `HTTP ${resp.status}`, latencyMs: Date.now() - ozonStart };
      } catch (err) {
        checks.ozonApi = { status: "error", message: (err as Error).message, latencyMs: Date.now() - ozonStart };
      }
    }

    // 3. Redis connectivity (via @onzo/cache healthCheck)
    const redisStart = Date.now();
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl && !redisUrl.includes("CHANGE_ME")) {
      try {
        const { cache } = await import("@onzo/cache");
        const hc = await cache.healthCheck();
        checks.redis = hc.available
          ? { status: "ok", latencyMs: hc.latencyMs }
          : { status: "degraded", message: "Redis ping failed", latencyMs: Date.now() - redisStart };
      } catch (err) {
        checks.redis = { status: "error", message: (err as Error).message, latencyMs: Date.now() - redisStart };
      }
    } else {
      checks.redis = { status: "unavailable", message: "REDIS_URL not configured" };
    }

    // 4. Disk space (backup dir + data dir)
    const diskStart = Date.now();
    try {
      const dirs = [
        process.env.BACKUP_DIR || "./data/backups",
        "./data",
      ];
      const diskChecks: Record<string, HealthDetail> = {};
      for (const dir of dirs) {
        try {
          const stats = await statfs(dir);
          const freeMb = (stats.bfree * stats.bsize) / (1024 * 1024);
          diskChecks[dir] = freeMb > 100
            ? { status: "ok", message: `${freeMb.toFixed(0)} MB free`, latencyMs: Date.now() - diskStart }
            : { status: "degraded", message: `only ${freeMb.toFixed(0)} MB free`, latencyMs: Date.now() - diskStart };
        } catch {
          diskChecks[dir] = { status: "unavailable", message: "directory not accessible" };
        }
      }
      checks.disk = diskChecks;
    } catch (err) {
      checks.disk = { status: "error", message: (err as Error).message, latencyMs: Date.now() - diskStart };
    }

    // 5. Model API keys present
    checks.glmKey = process.env.GLM_API_KEY && !process.env.GLM_API_KEY.includes("CHANGE_ME")
      ? { status: "ok" }
      : { status: "unavailable", message: "GLM_API_KEY not configured" };
    checks.deepseekKey = process.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_API_KEY.includes("CHANGE_ME")
      ? { status: "ok" }
      : { status: "unavailable", message: "DEEPSEEK_API_KEY not configured" };

    // Aggregate: 503 if any critical dependency is unavailable
    const isDetail = (v: HealthDetail | Record<string, HealthDetail>): v is HealthDetail =>
      "status" in v && typeof v.status === "string";

    const critFail = Object.entries(checks).some(([key, v]) => {
      if (key === "disk") {
        const disk = v as Record<string, HealthDetail>;
        return Object.values(disk).some((d) => d.status === "unavailable");
      }
      if (key === "redis") return false; // Redis is optional
      return isDetail(v) && (v.status === "error" || v.status === "unavailable");
    });

    res.status(critFail ? 503 : 200).json({
      status: critFail ? "degraded" : "ready",
      checkedAt: Date.now() - startedAt,
      checks,
    });
  });

  return router;
}
