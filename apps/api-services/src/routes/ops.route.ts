// ============================================================
// Ops Route — one-click maintenance endpoints
// ============================================================

import { Router } from "express";
import { readdirSync, statSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { authMiddleware } from "../middleware/auth.js";

export function createOpsRouter(): Router {
  const router = Router();
  router.use(authMiddleware);

  // ---- POST /ops/cleanup — clean temp files & stale DB records ----
  router.post("/ops/cleanup", async (_req, res) => {
    const result = { tmpImages: { deleted: 0, freedKB: 0 }, deadLetter: { deleted: 0 }, failedTasks: { deleted: 0 } };

    // 1. Clean tmp-images older than 24h
    const tmpDir = process.env.TMP_IMAGES_DIR || "./data/tmp-images";
    if (existsSync(tmpDir)) {
      try {
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        for (const f of readdirSync(tmpDir)) {
          const fp = join(tmpDir, f);
          try {
            const st = statSync(fp);
            if (now - st.mtimeMs > dayMs) {
              const size = st.size;
              unlinkSync(fp);
              result.tmpImages.deleted++;
              result.tmpImages.freedKB += Math.round(size / 1024);
            }
          } catch { /* skip individual file errors */ }
        }
      } catch (err) {
        logger.warn({ err }, "tmp-images cleanup partial");
      }
    }

    // 2. Clean dead-letter files older than 7 days
    const dlDir = process.env.DEAD_LETTER_DIR || "./dead-letter";
    if (existsSync(dlDir)) {
      try {
        const now = Date.now();
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        for (const f of readdirSync(dlDir)) {
          const fp = join(dlDir, f);
          try {
            if (now - statSync(fp).mtimeMs > weekMs) {
              unlinkSync(fp);
              result.deadLetter.deleted++;
            }
          } catch { /* skip */ }
        }
      } catch (err) {
        logger.warn({ err }, "dead-letter cleanup partial");
      }
    }

    // 3. Clean stale failed_tasks DB records (>7 days)
    try {
      const db = await getDb().catch(() => null);
      if (db) {
        const r = await db.run(
          "DELETE FROM failed_tasks WHERE status IN ('done','failed') AND completed_at IS NOT NULL AND completed_at < datetime('now','-7 days')",
        );
        result.failedTasks.deleted = r.changes;
      }
    } catch (err) {
      logger.warn({ err }, "failed_tasks cleanup partial");
    }

    res.json({ success: true, data: result });
  });

  // ---- GET /ops/health-panel — aggregated health dashboard ----
  router.get("/ops/health-panel", async (_req, res) => {
    const panel: Record<string, unknown> = { timestamp: new Date().toISOString() };

    // DB check
    try {
      const db = await getDb().catch(() => null);
      panel.db = db ? "connected" : "unavailable";
    } catch { panel.db = "error"; }

    // Disk usage
    try {
      const dataDir = process.env.BACKUP_DIR || "./data/backups";
      const s = statSync(dataDir);
      panel.disk = { dir: dataDir, mode: s.mode };
    } catch { panel.disk = "unknown"; }

    // Latest backup
    try {
      const buDir = process.env.BACKUP_DIR || "./data/backups";
      if (existsSync(buDir)) {
        const files = readdirSync(buDir)
          .filter((f) => f.endsWith(".sql.gz") || f.endsWith(".sql.gz.enc"))
          .map((f) => ({ name: f, ...statSync(join(buDir, f)) }))
          .sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (files.length > 0) {
          panel.latestBackup = { name: files[0].name, sizeKB: Math.round(files[0].size / 1024), ageHours: Math.round((Date.now() - files[0].mtimeMs) / 3600000) };
        }
      }
    } catch { panel.latestBackup = "unknown"; }

    // Env summary (safe keys only)
    panel.env = {
      NODE_ENV: process.env.NODE_ENV || "unknown",
      EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER || "unknown",
      REDIS_ENABLED: process.env.REDIS_ENABLED !== "false",
    };

    res.json(panel);
  });

  // ---- GET /ops/diagnose — comprehensive system diagnostic ----
  router.get("/ops/diagnose", async (_req, res) => {
    const diag: Record<string, unknown> = { timestamp: new Date().toISOString() };

    // 1. Redis health
    try {
      const { checkRedisHealth } = await import("../services/redis-health.js");
      diag.redis = await checkRedisHealth() ? "healthy" : "disconnected";
    } catch { diag.redis = "unknown"; }

    // 2. DB status
    try {
      const db = await getDb().catch(() => null);
      if (db) {
        const row = await db.all<{ cnt: number }>("SELECT COUNT(*) as cnt FROM purchase_1688");
        const row2 = await db.all<{ cnt: number }>("SELECT COUNT(*) as cnt FROM local_orders");
        diag.db = {
          status: "connected",
          totalPurchases: row[0]?.cnt || 0,
          totalOrders: row2[0]?.cnt || 0,
        };
      } else {
        diag.db = { status: "unavailable" };
      }
    } catch { diag.db = { status: "error" }; }

    // 3. Unpaid purchases (MANUAL_PAY_MODE)
    try {
      const db = await getDb().catch(() => null);
      if (db) {
        const row = await db.all<{ cnt: number }>(
          "SELECT COUNT(*) as cnt FROM purchase_1688 WHERE payment_status = 'pending_payment'"
        );
        diag.unpaidPurchases = row[0]?.cnt || 0;
      }
    } catch { diag.unpaidPurchases = -1; }

    // 4. RAG stats
    try {
      const db = await getDb().catch(() => null);
      if (db) {
        const tables = ["rag_aftersales_scripts", "rag_product_knowledge", "rag_copy_templates", "rag_operations_playbook", "rag_competitor_reports"];
        const ragStats: Record<string, number> = {};
        for (const t of tables) {
          const r = await db.all<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${t}`).catch(() => [{ cnt: -1 }]);
          ragStats[t] = r[0]?.cnt ?? -1;
        }
        diag.rag = ragStats;
      }
    } catch { diag.rag = "error"; }

    // 5. Dead letter queue
    try {
      const dlDir = process.env.DEAD_LETTER_DIR || "./dead-letter";
      if (existsSync(dlDir)) {
        diag.deadLetter = { count: readdirSync(dlDir).length, dir: dlDir };
      }
    } catch {}

    // 6. Process info
    diag.process = {
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      nodeVersion: process.version,
    };

    res.json({ success: true, data: diag });
  });

  // ---- POST /ops/backup — trigger database backup ----
  router.post("/ops/backup", async (_req, res) => {
    try {
      const { execSync } = await import("node:child_process");
      const result = execSync("bash scripts/backup-db.sh 2>&1", { timeout: 300_000, encoding: "utf-8" });
      res.json({ success: true, data: { output: result.trim() } });
    } catch (err) {
      res.json({ success: false, error: { code: "BACKUP_ERROR", message: (err as Error).message } });
    }
  });

  return router;
}
