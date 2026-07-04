// ============================================================
// Health check routes — n8n heartbeat + comprehensive readiness
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";

export function createHealthRouter(): Router {
  const router = Router();

  // GET /health — basic liveness (fast, no deps)
  router.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  // GET /ready — comprehensive readiness (DB + Ozon API + model keys)
  router.get("/ready", async (_req, res) => {
    const checks: Record<string, string> = {};

    // 1. Database
    try {
      const db = await getDb();
      if (db) { await db.all("SELECT 1"); checks.db = "ok"; }
      else { checks.db = "unavailable"; }
    } catch (err) { checks.db = `error: ${(err as Error).message}`; }

    // 2. Ozon API connectivity
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
      checks.ozonApi = resp.ok || resp.status === 400 ? "ok" : `http_${resp.status}`;
    } catch (err) { checks.ozonApi = `error: ${(err as Error).message}`; }

    // 3. Model API keys present
    checks.glmKey = process.env.GLM_API_KEY ? "configured" : "missing";
    checks.deepseekKey = process.env.DEEPSEEK_API_KEY ? "configured" : "missing";

    const allOk = Object.values(checks).every((v) => v === "ok" || v === "configured");
    res.status(allOk ? 200 : 503).json({ status: allOk ? "ready" : "degraded", checks });
  });

  return router;
}
