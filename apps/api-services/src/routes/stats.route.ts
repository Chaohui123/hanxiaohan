// ============================================================
// Stats routes — LLM token + COS storage + dashboard summaries
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export function createStatsRouter(): Router {
  const router = Router();

  // GET /api/stats/llm — daily + monthly token consumption summary
  router.get("/stats/llm", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) {
        res.json({ success: true, data: { todayTokens: 0, todayCost: 0, monthTokens: 0, dailyLimit: 500000 }, message: "DB not available" });
        return;
      }

      const today = new Date().toISOString().split("T")[0];
      const monthStart = today.substring(0, 7) + "-01";

      const todayRows = await db.all(
        "SELECT COALESCE(SUM(total_tokens),0) as tokens, COALESCE(SUM(cost_estimate),0) as cost FROM token_usage WHERE date(timestamp) = ?",
        [today]
      ) as Array<{ tokens: number; cost: number }>;

      const monthRows = await db.all(
        "SELECT COALESCE(SUM(total_tokens),0) as tokens FROM token_usage WHERE date(timestamp) >= ?",
        [monthStart]
      ) as Array<{ tokens: number }>;

      const dailyLimit = parseInt(process.env.LLM_DAILY_TOKEN_LIMIT || "500000", 10);

      // Per-model breakdown
      const breakdown = await db.all(
        "SELECT date(timestamp) as day, provider, model, SUM(prompt_tokens) as prompt, SUM(completion_tokens) as completion, SUM(total_tokens) as total, SUM(cost_estimate) as cost FROM token_usage GROUP BY day, provider, model ORDER BY day DESC LIMIT 30"
      );

      res.json({
        success: true,
        data: {
          todayTokens: todayRows[0]?.tokens ?? 0,
          todayCost: Math.round((todayRows[0]?.cost ?? 0) * 10000) / 10000,
          monthTokens: monthRows[0]?.tokens ?? 0,
          dailyLimit,
          breakdown,
        },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "DB_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId,
      });
    }
  });

  // GET /api/stats/cos — COS storage estimates from local dead-letter + images table
  router.get("/stats/cos", async (req, res) => {
    try {
      let images = 0;
      let totalSizeBytes = 0;
      let deadLetters = 0;

      const db = await getDb().catch(() => null);
      if (db) {
        try {
          const imgRows = await db.all(
            "SELECT COUNT(*) as cnt FROM images WHERE status = 'success'"
          ) as Array<{ cnt: number }>;
          images = imgRows[0]?.cnt ?? 0;

          const dlRows = await db.all(
            "SELECT COUNT(*) as cnt FROM images WHERE status = 'dead_letter'"
          ) as Array<{ cnt: number }>;
          deadLetters = dlRows[0]?.cnt ?? 0;
        } catch { /* images table may not exist */ }
      }

      // Estimate local dead-letter dir size
      const deadDir = process.env.DEAD_LETTER_DIR || "./dead-letter";
      if (existsSync(deadDir)) {
        try {
          const { readdirSync } = await import("node:fs");
          for (const f of readdirSync(deadDir)) {
            if (!f.endsWith(".meta.json")) {
              try { totalSizeBytes += statSync(join(deadDir, f)).size; } catch {}
            }
          }
        } catch {}
      }

      res.json({
        success: true,
        data: {
          images,
          totalSizeBytes,
          deadLetters,
          maxSizeBytes: 10 * 1024 * 1024 * 1024, // 10 GB
        },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "STATS_ERROR", message: (err as Error).message },
        correlationId: req.correlationId,
      });
    }
  });

  return router;
}
