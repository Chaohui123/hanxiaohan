// ============================================================
// Health check route — n8n heartbeat probe
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";

export function createHealthRouter(): Router {
  const router = Router();

  // Basic liveness probe
  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness probe — includes DB check
  router.get("/ready", async (_req, res) => {
    try {
      const db = await getDb();
      if (db) {
        await db.all("SELECT 1");
      }
      res.json({ status: "ready", db: "connected" });
    } catch (err) {
      res.status(503).json({
        status: "not_ready",
        db: "disconnected",
        error: (err as Error).message,
      });
    }
  });

  return router;
}
