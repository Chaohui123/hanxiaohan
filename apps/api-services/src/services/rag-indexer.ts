// ============================================================
// RAG Indexer — auto-build vector indexes from business data
// ============================================================

import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { EmbeddingClient } from "@onzo/embedding";

export class RagIndexer {
  private embeddingClient: EmbeddingClient;

  constructor() {
    this.embeddingClient = new EmbeddingClient();
  }

  /** 从售后工单历史构建话术库 */
  async indexAftersalesHistory(): Promise<number> {
    const db = await getDb().catch(() => null);
    if (!db) return 0;

    const cases = await db.all(`
      SELECT ac.id, ac.type, ac.reason, ac.buyer_message, ac.resolution_note
      FROM aftersales_cases ac
      WHERE ac.status = 'resolved'
        AND ac.resolution_note IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM rag_aftersales_scripts ras WHERE ras.id = 'imported_' || ac.id
        )
      LIMIT 50
    `) as Array<Record<string, unknown>>;

    if (cases.length === 0) return 0;

    const texts = cases.map((c) =>
      `场景: ${c.reason}\n买家消息: ${c.buyer_message}\n回复: ${c.resolution_note}`,
    );
    const embeddings = await this.embeddingClient.embedBatch(texts);

    let indexed = 0;
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const id = `imported_${c.id}`;
      try {
        await db.run(
          `INSERT INTO rag_aftersales_scripts (id, category, scenario, content_ru, source, embedding)
           VALUES ($1, $2, $3, $4, 'historical', $5::vector)
           ON CONFLICT (id) DO NOTHING`,
          [id, c.type, c.reason, c.resolution_note, `[${embeddings[i].vector.join(",")}]`],
        );
        indexed++;
      } catch (err) {
        logger.warn({ id, err: (err as Error).message }, "Failed to index aftersales case");
      }
    }

    logger.info({ indexed, total: cases.length }, "Aftersales history indexed");
    return indexed;
  }

  /** 从竞品价格历史构建分析报告 */
  async indexCompetitorReports(): Promise<number> {
    const db = await getDb().catch(() => null);
    if (!db) return 0;

    const watchItems = await db.all(`
      SELECT pw.offer_id, pw.name,
             COUNT(cp.id) as snapshot_count,
             AVG(cp.price) as avg_price,
             MIN(cp.price) as min_price,
             MAX(cp.price) as max_price
      FROM promo_watch_list pw
      JOIN promo_competitor_prices cp ON cp.offer_id = pw.offer_id
      WHERE cp.captured_at >= datetime('now', '-30 days')
      GROUP BY pw.offer_id, pw.name
      HAVING COUNT(cp.id) >= 5
    `) as Array<Record<string, unknown>>;

    if (watchItems.length === 0) return 0;

    let indexed = 0;
    for (const item of watchItems) {
      const reportText = [
        `商品: ${item.name} (offerId: ${item.offer_id})`,
        `近30天竞品价格: 均价${Math.round(Number(item.avg_price))}₽, 最低${Math.round(Number(item.min_price))}₽, 最高${Math.round(Number(item.max_price))}₽`,
        `数据快照数: ${item.snapshot_count}`,
      ].join("\n");

      const id = `competitor_${item.offer_id}_${new Date().toISOString().slice(0, 10)}`;

      const existing = (await db.all("SELECT id FROM rag_competitor_reports WHERE id = $1", [id]))[0] as
        Record<string, unknown> | undefined;
      if (existing) continue;

      const vector = (await this.embeddingClient.embed(reportText)).vector;
      await db.run(
        `INSERT INTO rag_competitor_reports (id, offer_id, report_text, price_trend_summary, embedding, period_start, period_end)
         VALUES ($1, $2, $3, $4, $5::vector, $6, $7)`,
        [
          id,
          item.offer_id,
          reportText,
          `均价${Math.round(Number(item.avg_price))}₽ 波动范围${Math.round(Number(item.min_price))}-${Math.round(Number(item.max_price))}₽`,
          `[${vector.join(",")}]`,
          new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
          new Date().toISOString().slice(0, 10),
        ],
      );
      indexed++;
    }

    logger.info({ indexed }, "Competitor reports indexed");
    return indexed;
  }

  /** 从品类机会数据构建选品知识 */
  async indexCategoryOpportunities(): Promise<number> {
    const db = await getDb().catch(() => null);
    if (!db) return 0;

    const opportunities = await db.all(`
      SELECT category_id, category_name, overall_score, listing_count,
             avg_price_rub, est_margin, month_orders, recommendation
      FROM category_opportunities
      WHERE overall_score > 0
    `) as Array<Record<string, unknown>>;

    if (opportunities.length === 0) return 0;

    const texts = opportunities.map(
      (o) =>
        `品类: ${o.category_name} (ID: ${o.category_id})\n评分: ${o.overall_score}\n在售数: ${o.listing_count}\n均价: ${o.avg_price_rub}₽\n预估利润率: ${o.est_margin}%\n月订单: ${o.month_orders}\n建议: ${o.recommendation}`,
    );
    const embeddings = await this.embeddingClient.embedBatch(texts);

    let indexed = 0;
    for (let i = 0; i < opportunities.length; i++) {
      const o = opportunities[i];
      const id = `category_${o.category_id}`;
      try {
        await db.run(
          `INSERT INTO rag_product_knowledge (id, category_id, category_name, title, content, keywords, embedding, data_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector, 'api')
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             embedding = EXCLUDED.embedding,
             updated_at = datetime('now')`,
          [
            id,
            o.category_id,
            o.category_name,
            `${o.category_name} 品类分析`,
            texts[i],
            [o.category_name, `score_${o.overall_score}`].join(","),
            `[${embeddings[i].vector.join(",")}]`,
          ],
        );
        indexed++;
      } catch (err) {
        logger.warn({ id, err: (err as Error).message }, "Failed to index category");
      }
    }

    logger.info({ indexed }, "Category opportunities indexed");
    return indexed;
  }

  /** 从推广文案历史构建文案模板库 */
  async indexCopyHistory(): Promise<number> {
    const db = await getDb().catch(() => null);
    if (!db) return 0;

    const copies = await db.all(`
      SELECT offer_id, name, title_ru
      FROM promo_copy_history
      WHERE title_ru IS NOT NULL
    `) as Array<Record<string, unknown>>;

    if (copies.length === 0) return 0;

    let indexed = 0;
    for (const c of copies) {
      const id = `copy_${c.offer_id}`;
      const vector = (await this.embeddingClient.embed(String(c.title_ru))).vector;
      try {
        await db.run(
          `INSERT INTO rag_copy_templates (id, category, original_text, embedding)
           VALUES ($1, 'product_title', $2, $3::vector)
           ON CONFLICT (id) DO UPDATE SET
             original_text = EXCLUDED.original_text,
             embedding = EXCLUDED.embedding`,
          [id, c.title_ru, `[${vector.join(",")}]`],
        );
        indexed++;
      } catch (err) {
        logger.warn({ id, err: (err as Error).message }, "Failed to index copy");
      }
    }

    logger.info({ indexed }, "Copy history indexed");
    return indexed;
  }

  /** 全量重建索引 */
  async reindexAll(): Promise<Record<string, number>> {
    const results = {
      aftersales: 0,
      competitor: 0,
      category: 0,
      copy: 0,
    };
    try { results.aftersales = await this.indexAftersalesHistory(); } catch (err) { logger.error({ err }, "Aftersales index failed"); }
    try { results.competitor = await this.indexCompetitorReports(); } catch (err) { logger.error({ err }, "Competitor index failed"); }
    try { results.category = await this.indexCategoryOpportunities(); } catch (err) { logger.error({ err }, "Category index failed"); }
    try { results.copy = await this.indexCopyHistory(); } catch (err) { logger.error({ err }, "Copy index failed"); }
    return results;
  }
}
