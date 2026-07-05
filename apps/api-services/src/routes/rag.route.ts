// ============================================================
// RAG Knowledge Base Routes — Zod-validated CRUD + Vector Search
// ============================================================

import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { EmbeddingClient } from "@onzo/embedding";
import { validate } from "../middleware/validate.js";
import { ragRateLimit } from "../middleware/rag-rate-limit.js";
import { AppError } from "../errors/index.js";

// ---- Zod Schemas ----

const SearchSchema = z.object({
  query: z.string().min(1).max(500),
  category: z.string().optional(),
  scenario: z.string().optional(),
  topK: z.number().int().min(1).max(20).optional().default(5),
});

const AftersalesCreateSchema = z.object({
  category: z.string().min(1).max(100),
  scenario: z.string().min(1).max(200),
  contentRu: z.string().min(1).max(5000),
  contentZh: z.string().max(5000).optional(),
  keywords: z.array(z.string().max(50)).max(20).optional(),
  source: z.string().max(50).optional(),
});

const AftersalesFeedbackSchema = z.object({ effective: z.boolean() });

const CompetitorCreateSchema = z.object({
  offerId: z.string().min(1).max(100),
  reportText: z.string().min(1).max(10000),
  priceTrendSummary: z.string().max(5000).optional(),
});

const ProductCreateSchema = z.object({
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(10000),
  category: z.string().max(100).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

const CopyCreateSchema = z.object({
  category: z.string().min(1).max(100),
  originalText: z.string().min(1).max(5000),
  optimizedText: z.string().max(5000).optional(),
  effectivenessScore: z.number().min(0).max(1).optional(),
});

const PlaybookCreateSchema = z.object({
  title: z.string().min(1).max(300),
  scenario: z.string().min(1).max(100),
  content: z.string().min(1).max(10000),
  tags: z.array(z.string().max(50)).max(20).optional(),
  author: z.string().max(50).optional(),
  priority: z.number().int().min(0).max(10).optional(),
});

const ImportSchema = z.object({ limit: z.number().int().min(1).max(200).optional() });

// ---- Helpers ----

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function dbOrFail() {
  const db = await getDb().catch(() => null);
  if (!db) throw new AppError("SERVICE_UNAVAILABLE", "Database unavailable", true, 503);
  return db;
}

function handleError(err: unknown): never {
  if (err instanceof AppError) throw err;
  throw new AppError("RAG_ERROR", (err as Error).message, true, 500);
}

const embeddingClient = new EmbeddingClient();

// ---- Router ----

export function createRagRouter(): Router {
  const router = Router();
  router.use(ragRateLimit);

  // ============================================================
  // 售后话术
  // ============================================================

  router.post("/rag/aftersales/search", validate(SearchSchema), async (req, res) => {
    try {
      const { query, category, topK } = (req as unknown as Record<string, unknown>).validatedBody as z.infer<typeof SearchSchema>;
      const db = await dbOrFail();
      const queryVector = (await embeddingClient.embed(query)).vector;
      const vecStr = `[${queryVector.join(",")}]`;
      const params: unknown[] = [vecStr];
      if (category) params.push(category);
      params.push(topK);
      const rows = await db.all(
        `SELECT id, category, scenario, content_ru, content_zh, keywords, source,
                effectiveness_score, usage_count, 1 - (embedding <=> $1::vector) AS score
         FROM rag_aftersales_scripts WHERE 1=1 ${category ? "AND category = $2" : ""}
         ORDER BY embedding <=> $1::vector LIMIT $${params.length}`, params,
      );
      res.json({ results: rows, query });
    } catch (err) { handleError(err); }
  });

  router.post("/rag/aftersales", validate(AftersalesCreateSchema), async (req, res) => {
    try {
      const body = (req as unknown as Record<string, unknown>).validatedBody as z.infer<typeof AftersalesCreateSchema>;
      const db = await dbOrFail();
      const id = genId("script");
      const vector = (await embeddingClient.embed(`${body.scenario} ${body.contentRu}`)).vector;
      await db.run(
        `INSERT INTO rag_aftersales_scripts (id, category, scenario, content_ru, content_zh, keywords, source, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
        [id, body.category, body.scenario, body.contentRu, body.contentZh || null,
          body.keywords || [], body.source || "manual", `[${vector.join(",")}]`],
      );
      res.json({ id, message: "话术已添加" });
    } catch (err) { handleError(err); }
  });

  router.put("/rag/aftersales/:id/feedback", validate(AftersalesFeedbackSchema), async (req, res) => {
    try {
      const { effective } = (req as unknown as Record<string, unknown>).validatedBody as z.infer<typeof AftersalesFeedbackSchema>;
      const db = await dbOrFail();
      const delta = effective ? 0.1 : -0.1;
      await db.run(
        `UPDATE rag_aftersales_scripts SET usage_count = usage_count + 1,
         effectiveness_score = GREATEST(0, LEAST(1, effectiveness_score + $2)), updated_at = NOW()
         WHERE id = $1`, [req.params.id, delta],
      );
      res.json({ message: "反馈已记录" });
    } catch (err) { handleError(err); }
  });

  // ============================================================
  // 竞品分析报告
  // ============================================================

  router.post("/rag/competitor/search", validate(SearchSchema), async (req, res) => {
    try {
      const { query, topK } = (req as unknown as Record<string, unknown>).validatedBody as z.infer<typeof SearchSchema>;
      const db = await dbOrFail();
      const queryVector = (await embeddingClient.embed(query)).vector;
      const rows = await db.all(
        `SELECT id, offer_id, category_id, report_text, price_trend_summary, action_suggestion,
                period_start, period_end, 1 - (embedding <=> $1::vector) AS score
         FROM rag_competitor_reports ORDER BY embedding <=> $1::vector LIMIT $2`,
        [`[${queryVector.join(",")}]`, topK],
      );
      res.json({ results: rows, query });
    } catch (err) { handleError(err); }
  });

  router.post("/rag/competitor", validate(CompetitorCreateSchema), async (req, res) => {
    try {
      const body = (req as unknown as Record<string, unknown>).validatedBody as z.infer<typeof CompetitorCreateSchema>;
      const db = await dbOrFail();
      const id = genId("comp");
      const embedText = `${body.reportText} ${body.priceTrendSummary || ""}`;
      const vector = (await embeddingClient.embed(embedText)).vector;
      await db.run(
        `INSERT INTO rag_competitor_reports (id, offer_id, report_text, price_trend_summary, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [id, body.offerId, body.reportText, body.priceTrendSummary || null, `[${vector.join(",")}]`],
      );
      res.json({ id, message: "竞品报告已保存" });
    } catch (err) { handleError(err); }
  });

  // ============================================================
  // 选品知识
  // ============================================================

  router.post("/rag/product/search", validate(SearchSchema), async (req, res) => {
    try {
      const { query, topK } = (req as unknown as Record<string, unknown>).validatedBody as z.infer<typeof SearchSchema>;
      const db = await dbOrFail();
      const queryVector = (await embeddingClient.embed(query)).vector;
      const rows = await db.all(
        `SELECT id, category_id, category_name, title, content, source_url, keywords, data_source,
                1 - (embedding <=> $1::vector) AS score
         FROM rag_product_knowledge ORDER BY embedding <=> $1::vector LIMIT $2`,
        [`[${queryVector.join(",")}]`, topK],
      );
      res.json({ results: rows, query });
    } catch (err) { handleError(err); }
  });

  router.post("/rag/product", validate(ProductCreateSchema), async (req, res) => {
    try {
      const body = (req as unknown as Record<string, unknown>).validatedBody as z.infer<typeof ProductCreateSchema>;
      const db = await dbOrFail();
      const id = genId("prod");
      const vector = (await embeddingClient.embed(`${body.title} ${body.content}`)).vector;
      await db.run(
        `INSERT INTO rag_product_knowledge (id, category_name, title, content, source_url, keywords, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [id, body.category || null, body.title, body.content, null, body.tags || [], `[${vector.join(",")}]`],
      );
      res.json({ id, message: "选品知识已添加" });
    } catch (err) { handleError(err); }
  });

  // ============================================================
  // 推广文案模板
  // ============================================================

  router.post("/rag/copy/search", validate(SearchSchema), async (req, res) => {
    try {
      const { query, topK } = (req as unknown as Record<string, unknown>).validatedBody as z.infer<typeof SearchSchema>;
      const db = await dbOrFail();
      const queryVector = (await embeddingClient.embed(query)).vector;
      const rows = await db.all(
        `SELECT id, category, category_id, original_text, optimized_text, optimization_notes, performance_score,
                1 - (embedding <=> $1::vector) AS score
         FROM rag_copy_templates ORDER BY embedding <=> $1::vector LIMIT $2`,
        [`[${queryVector.join(",")}]`, topK],
      );
      res.json({ results: rows, query });
    } catch (err) { handleError(err); }
  });

  router.post("/rag/copy", validate(CopyCreateSchema), async (req, res) => {
    try {
      const body = (req as unknown as Record<string, unknown>).validatedBody as z.infer<typeof CopyCreateSchema>;
      const db = await dbOrFail();
      const id = genId("copy");
      const embedText = `${body.originalText} ${body.optimizedText || ""}`;
      const vector = (await embeddingClient.embed(embedText)).vector;
      await db.run(
        `INSERT INTO rag_copy_templates (id, category, original_text, optimized_text, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [id, body.category, body.originalText, body.optimizedText || null, `[${vector.join(",")}]`],
      );
      res.json({ id, message: "文案模板已添加" });
    } catch (err) { handleError(err); }
  });

  // ============================================================
  // 运营 Playbook
  // ============================================================

  router.post("/rag/playbook/search", validate(SearchSchema), async (req, res) => {
    try {
      const { query, scenario, topK } = (req as unknown as Record<string, unknown>).validatedBody as z.infer<typeof SearchSchema>;
      const db = await dbOrFail();
      const queryVector = (await embeddingClient.embed(query)).vector;
      const params: unknown[] = [`[${queryVector.join(",")}]`];
      if (scenario) params.push(scenario);
      params.push(topK);
      const rows = await db.all(
        `SELECT id, title, scenario, content, tags, author, priority,
                1 - (embedding <=> $1::vector) AS score
         FROM rag_operations_playbook WHERE 1=1 ${scenario ? "AND scenario = $2" : ""}
         ORDER BY embedding <=> $1::vector LIMIT $${params.length}`, params,
      );
      res.json({ results: rows, query });
    } catch (err) { handleError(err); }
  });

  router.post("/rag/playbook", validate(PlaybookCreateSchema), async (req, res) => {
    try {
      const body = (req as unknown as Record<string, unknown>).validatedBody as z.infer<typeof PlaybookCreateSchema>;
      const db = await dbOrFail();
      const id = genId("pb");
      const vector = (await embeddingClient.embed(`${body.title} ${body.content}`)).vector;
      await db.run(
        `INSERT INTO rag_operations_playbook (id, title, scenario, content, tags, author, priority, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
        [id, body.title, body.scenario, body.content, body.tags || [], body.author || "system",
          body.priority || 0, `[${vector.join(",")}]`],
      );
      res.json({ id, message: "运营经验已添加" });
    } catch (err) { handleError(err); }
  });

  // ============================================================
  // 批量导入
  // ============================================================

  router.post("/rag/import/aftersales-history", validate(ImportSchema), async (req, res) => {
    try {
      const db = await dbOrFail();
      const cases = await db.all(
        `SELECT id, type, reason, buyer_message, resolution_note
         FROM aftersales_cases WHERE status = 'resolved' AND resolution_note IS NOT NULL LIMIT 100`,
      ) as Array<Record<string, unknown>>;
      let imported = 0;
      for (const c of cases) {
        const content = `${c.reason || ""}: ${c.resolution_note || ""}`;
        const vector = (await embeddingClient.embed(content)).vector;
        await db.run(
          `INSERT INTO rag_aftersales_scripts (id, category, scenario, content_ru, source, embedding)
           VALUES ($1, $2, $3, $4, 'historical', $5::vector) ON CONFLICT (id) DO NOTHING`,
          [`imported_${c.id}`, c.type || "other", c.reason || "", c.resolution_note || "", `[${vector.join(",")}]`],
        );
        imported++;
      }
      res.json({ imported, total: cases.length });
    } catch (err) { handleError(err); }
  });

  router.post("/rag/import/competitor-history", validate(ImportSchema), (_req, res) => {
    res.json({ message: "竞品历史导入功能待实现（需 DeepSeek 摘要 + Embedding）", imported: 0 });
  });

  // ============================================================
  // 统计
  // ============================================================

  router.get("/rag/stats", async (_req, res) => {
    try {
      const db = await dbOrFail();
      const tables = ["rag_aftersales_scripts", "rag_competitor_reports", "rag_product_knowledge", "rag_copy_templates", "rag_operations_playbook"];
      const stats: Record<string, number> = {};
      for (const t of tables) {
        const rows = await db.all<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${t}`);
        stats[t] = rows[0]?.cnt || 0;
      }
      res.json(stats);
    } catch (err) { handleError(err); }
  });

  return router;
}
