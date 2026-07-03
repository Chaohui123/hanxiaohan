// ============================================================
// Stats routes — LLM token consumption, daily cost reports
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";

export function createStatsRouter(): Router {
  const router = Router();

  // GET /api/stats/llm — daily token consumption
  router.get("/stats/llm", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) {
        res.json({ success: true, data: [], message: "DB not available" });
        return;
      }

      const rows = await db.all(
        `SELECT date(timestamp) as day, provider, model,
                SUM(prompt_tokens) as prompt, SUM(completion_tokens) as completion,
                SUM(total_tokens) as total, SUM(cost_estimate) as cost
         FROM token_usage
         GROUP BY day, provider, model
         ORDER BY day DESC
         LIMIT 30`
      );

      res.json({ success: true, data: rows, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "DB_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId,
      });
    }
  });

  return router;
}
