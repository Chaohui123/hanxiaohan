// ============================================================
// RAG Knowledge Base Routes — CRUD + Vector Search
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { EmbeddingClient } from "@onzo/embedding";

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function dbOrFail(res: { status: (c: number) => { json: (d: unknown) => unknown } }) {
  const db = await getDb().catch(() => null);
  if (!db) {
    res.status(503).json({ error: "DB unavailable" });
    return null;
  }
  return db;
}

const embeddingClient = new EmbeddingClient();

export function createRagRouter(): Router {
  const router = Router();

  // ============================================================
  // 售后话术
  // ============================================================

  router.post("/rag/aftersales/search", async (req, res) => {
    try {
      const { query, category, topK = 5 } = req.body as { query?: string; category?: string; topK?: number };
      if (!query) { res.status(400).json({ error: "query is required" }); return; }

      const db = await dbOrFail(res);
      if (!db) return;

      const queryVector = (await embeddingClient.embed(query)).vector;
      const vecStr = `[${queryVector.join(",")}]`;
      const categoryFilter = category ? `AND category = $2` : "";
      const params: unknown[] = [vecStr];
      if (category) params.push(category);
      params.push(topK);

      const rows = await db.all(
        `SELECT id, category, scenario, content_ru, content_zh, keywords, source,
                effectiveness_score, usage_count,
                1 - (embedding <=> $1::vector) AS score
         FROM rag_aftersales_scripts
         WHERE 1=1 ${categoryFilter}
         ORDER BY embedding <=> $1::vector
         LIMIT $${params.length}`,
        params,
      );

      res.json({ results: rows, query });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/rag/aftersales", async (req, res) => {
    try {
      const { category, scenario, contentRu, contentZh, keywords, source } = req.body as {
        category?: string; scenario?: string; contentRu?: string; contentZh?: string;
        keywords?: string[]; source?: string;
      };
      if (!category || !scenario || !contentRu) {
        res.status(400).json({ error: "category, scenario, contentRu are required" }); return;
      }

      const db = await dbOrFail(res);
      if (!db) return;

      const id = genId("script");
      const vector = (await embeddingClient.embed(`${scenario} ${contentRu}`)).vector;
      const vecStr = `[${vector.join(",")}]`;

      await db.run(
        `INSERT INTO rag_aftersales_scripts (id, category, scenario, content_ru, content_zh, keywords, source, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
        [id, category, scenario, contentRu, contentZh || null, keywords || [], source || "manual", vecStr],
      );

      res.json({ id, message: "话术已添加" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put("/rag/aftersales/:id/feedback", async (req, res) => {
    try {
      const { effective } = req.body as { effective?: boolean };
      const db = await dbOrFail(res);
      if (!db) return;

      const delta = effective ? 0.1 : -0.1;
      await db.run(
        `UPDATE rag_aftersales_scripts
         SET usage_count = usage_count + 1,
             effectiveness_score = GREATEST(0, LEAST(1, effectiveness_score + $2)),
             updated_at = NOW()
         WHERE id = $1`,
        [req.params.id, delta],
      );

      res.json({ message: "反馈已记录" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ============================================================
  // 竞品分析报告
  // ============================================================

  router.post("/rag/competitor/search", async (req, res) => {
    try {
      const { query, offerId, topK = 5 } = req.body as { query?: string; offerId?: string; topK?: number };
      if (!query) { res.status(400).json({ error: "query is required" }); return; }

      const db = await dbOrFail(res);
      if (!db) return;

      const queryVector = (await embeddingClient.embed(query)).vector;
      const vecStr = `[${queryVector.join(",")}]`;
      const offerFilter = offerId ? `AND offer_id = $2` : "";
      const params: unknown[] = [vecStr];
      if (offerId) params.push(offerId);
      params.push(topK);

      const rows = await db.all(
        `SELECT id, offer_id, category_id, report_text, price_trend_summary, action_suggestion,
                period_start, period_end,
                1 - (embedding <=> $1::vector) AS score
         FROM rag_competitor_reports
         WHERE 1=1 ${offerFilter}
         ORDER BY embedding <=> $1::vector
         LIMIT $${params.length}`,
        params,
      );

      res.json({ results: rows, query });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/rag/competitor", async (req, res) => {
    try {
      const { offerId, categoryId, reportText, priceTrendSummary, actionSuggestion, periodStart, periodEnd } = req.body as {
        offerId?: string; categoryId?: number; reportText?: string;
        priceTrendSummary?: string; actionSuggestion?: string;
        periodStart?: string; periodEnd?: string;
      };
      if (!offerId || !reportText) {
        res.status(400).json({ error: "offerId and reportText are required" }); return;
      }

      const db = await dbOrFail(res);
      if (!db) return;

      const id = genId("comp");
      const embedText = `${reportText} ${actionSuggestion || ""}`;
      const vector = (await embeddingClient.embed(embedText)).vector;
      const vecStr = `[${vector.join(",")}]`;

      await db.run(
        `INSERT INTO rag_competitor_reports (id, offer_id, category_id, report_text, price_trend_summary, action_suggestion, period_start, period_end, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
        [id, offerId, categoryId || null, reportText, priceTrendSummary || null,
          actionSuggestion || null, periodStart || null, periodEnd || null, vecStr],
      );

      res.json({ id, message: "竞品报告已保存" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ============================================================
  // 选品知识
  // ============================================================

  router.post("/rag/product/search", async (req, res) => {
    try {
      const { query, categoryId, topK = 5 } = req.body as { query?: string; categoryId?: number; topK?: number };
      if (!query) { res.status(400).json({ error: "query is required" }); return; }

      const db = await dbOrFail(res);
      if (!db) return;

      const queryVector = (await embeddingClient.embed(query)).vector;
      const vecStr = `[${queryVector.join(",")}]`;
      const catFilter = categoryId ? `AND category_id = $2` : "";
      const params: unknown[] = [vecStr];
      if (categoryId) params.push(categoryId);
      params.push(topK);

      const rows = await db.all(
        `SELECT id, category_id, category_name, title, content, source_url, keywords, data_source,
                1 - (embedding <=> $1::vector) AS score
         FROM rag_product_knowledge
         WHERE 1=1 ${catFilter}
         ORDER BY embedding <=> $1::vector
         LIMIT $${params.length}`,
        params,
      );

      res.json({ results: rows, query });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/rag/product", async (req, res) => {
    try {
      const { categoryId, categoryName, title, content, sourceUrl, keywords, dataSource } = req.body as {
        categoryId?: number; categoryName?: string; title?: string; content?: string;
        sourceUrl?: string; keywords?: string[]; dataSource?: string;
      };
      if (!title || !content) { res.status(400).json({ error: "title and content are required" }); return; }

      const db = await dbOrFail(res);
      if (!db) return;

      const id = genId("prod");
      const vector = (await embeddingClient.embed(`${title} ${content}`)).vector;
      const vecStr = `[${vector.join(",")}]`;

      await db.run(
        `INSERT INTO rag_product_knowledge (id, category_id, category_name, title, content, source_url, keywords, data_source, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
        [id, categoryId || null, categoryName || null, title, content, sourceUrl || null,
          keywords || [], dataSource || "manual", vecStr],
      );

      res.json({ id, message: "选品知识已添加" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ============================================================
  // 推广文案模板
  // ============================================================

  router.post("/rag/copy/search", async (req, res) => {
    try {
      const { query, category, topK = 5 } = req.body as { query?: string; category?: string; topK?: number };
      if (!query) { res.status(400).json({ error: "query is required" }); return; }

      const db = await dbOrFail(res);
      if (!db) return;

      const queryVector = (await embeddingClient.embed(query)).vector;
      const vecStr = `[${queryVector.join(",")}]`;
      const catFilter = category ? `AND category = $2` : "";
      const params: unknown[] = [vecStr];
      if (category) params.push(category);
      params.push(topK);

      const rows = await db.all(
        `SELECT id, category, category_id, original_text, optimized_text, optimization_notes, performance_score,
                1 - (embedding <=> $1::vector) AS score
         FROM rag_copy_templates
         WHERE 1=1 ${catFilter}
         ORDER BY embedding <=> $1::vector
         LIMIT $${params.length}`,
        params,
      );

      res.json({ results: rows, query });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/rag/copy", async (req, res) => {
    try {
      const { category, categoryId, originalText, optimizedText, optimizationNotes } = req.body as {
        category?: string; categoryId?: number; originalText?: string;
        optimizedText?: string; optimizationNotes?: string;
      };
      if (!category || !originalText) {
        res.status(400).json({ error: "category and originalText are required" }); return;
      }

      const db = await dbOrFail(res);
      if (!db) return;

      const id = genId("copy");
      const embedText = `${originalText} ${optimizedText || ""}`;
      const vector = (await embeddingClient.embed(embedText)).vector;
      const vecStr = `[${vector.join(",")}]`;

      await db.run(
        `INSERT INTO rag_copy_templates (id, category, category_id, original_text, optimized_text, optimization_notes, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [id, category, categoryId || null, originalText, optimizedText || null, optimizationNotes || null, vecStr],
      );

      res.json({ id, message: "文案模板已添加" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ============================================================
  // 运营 Playbook
  // ============================================================

  router.post("/rag/playbook/search", async (req, res) => {
    try {
      const { query, scenario, topK = 5 } = req.body as { query?: string; scenario?: string; topK?: number };
      if (!query) { res.status(400).json({ error: "query is required" }); return; }

      const db = await dbOrFail(res);
      if (!db) return;

      const queryVector = (await embeddingClient.embed(query)).vector;
      const vecStr = `[${queryVector.join(",")}]`;
      const scFilter = scenario ? `AND scenario = $2` : "";
      const params: unknown[] = [vecStr];
      if (scenario) params.push(scenario);
      params.push(topK);

      const rows = await db.all(
        `SELECT id, title, scenario, content, tags, author, priority,
                1 - (embedding <=> $1::vector) AS score
         FROM rag_operations_playbook
         WHERE 1=1 ${scFilter}
         ORDER BY embedding <=> $1::vector
         LIMIT $${params.length}`,
        params,
      );

      res.json({ results: rows, query });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/rag/playbook", async (req, res) => {
    try {
      const { title, scenario, content, tags, author, priority } = req.body as {
        title?: string; scenario?: string; content?: string;
        tags?: string[]; author?: string; priority?: number;
      };
      if (!title || !scenario || !content) {
        res.status(400).json({ error: "title, scenario, content are required" }); return;
      }

      const db = await dbOrFail(res);
      if (!db) return;

      const id = genId("pb");
      const vector = (await embeddingClient.embed(`${title} ${content}`)).vector;
      const vecStr = `[${vector.join(",")}]`;

      await db.run(
        `INSERT INTO rag_operations_playbook (id, title, scenario, content, tags, author, priority, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
        [id, title, scenario, content, tags || [], author || "system", priority || 0, vecStr],
      );

      res.json({ id, message: "运营经验已添加" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ============================================================
  // 批量导入
  // ============================================================

  router.post("/rag/import/aftersales-history", async (req, res) => {
    try {
      const db = await dbOrFail(res);
      if (!db) return;

      const cases = await db.all(
        `SELECT id, type, reason, buyer_message, resolution_note
         FROM aftersales_cases
         WHERE status = 'resolved' AND resolution_note IS NOT NULL
         LIMIT 100`,
      ) as Array<Record<string, unknown>>;

      let imported = 0;
      for (const c of cases) {
        const content = `${c.reason || ""}: ${c.resolution_note || ""}`;
        const vector = (await embeddingClient.embed(content)).vector;
        const vecStr = `[${vector.join(",")}]`;

        await db.run(
          `INSERT INTO rag_aftersales_scripts (id, category, scenario, content_ru, source, embedding)
           VALUES ($1, $2, $3, $4, 'historical', $5::vector)
           ON CONFLICT (id) DO NOTHING`,
          [`imported_${c.id}`, c.type || "other", c.reason || "", c.resolution_note || "", vecStr],
        );
        imported++;
      }

      res.json({ imported, total: cases.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/rag/import/competitor-history", async (_req, res) => {
    // Placeholder: aggregate from promo_competitor_prices + promo_events,
    // use DeepSeek to generate summary, then embedding upsert.
    res.json({ message: "竞品历史导入功能待实现（需 DeepSeek 摘要 + Embedding）", imported: 0 });
  });

  // ============================================================
  // 统计
  // ============================================================

  router.get("/rag/stats", async (_req, res) => {
    try {
      const db = await dbOrFail(res);
      if (!db) return;

      const tables = [
        "rag_aftersales_scripts",
        "rag_competitor_reports",
        "rag_product_knowledge",
        "rag_copy_templates",
        "rag_operations_playbook",
      ];

      const stats: Record<string, number> = {};
      for (const t of tables) {
        const rows = await db.all<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${t}`);
        stats[t] = rows[0]?.cnt || 0;
      }

      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
