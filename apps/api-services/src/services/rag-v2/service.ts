// ============================================================
// RAG v2 Service — 3 collections, chunked embeddings, Top5 injection
// SQLite-compatible vector store. RAG_ENABLE env toggle.
// ============================================================

import { EmbeddingClient } from "@onzo/embedding";
import type { DbAdapter } from "../../db/connection.js";
import { SqliteVectorStore, type SearchResult } from "./sqlite-store.js";
import { chunkText, estimateChunkCount } from "./chunker.js";
import { estimateTokens, truncateContext, countMessageTokens } from "./token-counter.js";
import { logger } from "@onzo/logger";

// ---- Types ----

export interface RagSearchOptions {
  collection: string;
  query: string;
  topK?: number;
  similarityThreshold?: number;
}

export interface RagIndexInput {
  collection: string;
  id: string;
  content: string;
  metadata?: Record<string, string>;
}

export interface RagStats {
  enabled: boolean;
  store: "sqlite" | "pgvector" | "none";
  totalDocs: number;
  totalBytes: number;
  byCollection: Record<string, { count: number; totalBytes: number }>;
  avgSearchMs: number;
  searchCount: number;
  embeddingModel: string;
  embeddingDimensions: number;
}

// ---- Config ----

const CHUNK_BYTES = parseInt(process.env.RAG_CHUNK_SIZE_BYTES || "10240", 10); // 10KB
const SIMILARITY_THRESHOLD = parseFloat(process.env.RAG_SIMILARITY_THRESHOLD || "0.6");
const MAX_CONTEXT_TOKENS = parseInt(process.env.RAG_MAX_CONTEXT_TOKENS || "3000", 10);

// ---- Service ----

export class RagV2Service {
  private store: SqliteVectorStore | null = null;
  private embedding: EmbeddingClient;
  private searchTimings: number[] = [];
  private searchCount = 0;

  constructor(private db: DbAdapter | null) {
    this.embedding = new EmbeddingClient();
    if (db) {
      this.store = new SqliteVectorStore(db);
    }
  }

  get enabled(): boolean {
    const flag = process.env.RAG_ENABLE;
    if (flag === "false" || flag === "0" || flag === "off") return false;
    return this.store !== null;
  }

  async init(): Promise<void> {
    if (!this.store) return;
    await this.store.initSchema();
    logger.info("RAG v2: SQLite vector store initialized");
  }

  // ---- Search ----

  /** Search across a collection with vector similarity. */
  async search(options: RagSearchOptions): Promise<SearchResult[]> {
    if (!this.enabled || !this.store) return [];

    const t0 = Date.now();
    try {
      const vector = (await this.embedding.embed(options.query)).vector;
      const results = await this.store.search(
        options.collection,
        vector,
        options.topK || 5,
        options.similarityThreshold ?? SIMILARITY_THRESHOLD
      );
      this.searchTimings.push(Date.now() - t0);
      if (this.searchTimings.length > 100) this.searchTimings.shift();
      this.searchCount++;
      return results;
    } catch (err) {
      logger.warn({ err: (err as Error).message, collection: options.collection }, "RAG v2: search failed, falling back");
      return [];
    }
  }

  /**
   * Search and format results for LLM prompt injection.
   * Returns a context string ready to prepend to the system prompt.
   */
  async searchForPrompt(options: RagSearchOptions): Promise<string> {
    const results = await this.search(options);
    if (results.length === 0) return "";

    const lines = results.map((r, i) =>
      `[样本${i + 1}] 相似度: ${(r.similarity * 100).toFixed(1)}%\n${r.doc.content.slice(0, 2000)}`
    );
    const context = `\n\n--- 历史参考样本 (RAG检索Top${results.length}) ---\n${lines.join("\n\n")}\n--- 样本结束 ---\n`;

    // Truncate if too long
    const tokens = estimateTokens(context);
    if (tokens > MAX_CONTEXT_TOKENS) {
      return context.slice(0, MAX_CONTEXT_TOKENS * 4); // rough char estimate
    }
    return context;
  }

  // ---- Index ----

  /** Index a single document (chunked + embedded). */
  async index(input: RagIndexInput): Promise<number> {
    if (!this.enabled || !this.store) return 0;

    const chunks = chunkText(input.content, { maxChunkBytes: CHUNK_BYTES });
    let count = 0;

    for (let i = 0; i < chunks.length; i++) {
      try {
        const embResult = await this.embedding.embed(chunks[i]);
        await this.store.insert({
          id: chunks.length > 1 ? `${input.id}_chunk${i}` : input.id,
          collection: input.collection,
          content: chunks[i],
          metadata: input.metadata || {},
          vector: embResult.vector,
          tokenCount: embResult.tokenCount,
          byteLength: Buffer.byteLength(chunks[i], "utf-8"),
        });
        count++;
      } catch (err) {
        logger.warn({ err: (err as Error).message, id: input.id, chunk: i }, "RAG v2: index chunk failed");
      }
    }

    return count;
  }

  /** Batch index multiple documents. */
  async indexBatch(inputs: RagIndexInput[]): Promise<number> {
    let total = 0;
    for (const input of inputs) {
      total += await this.index(input);
    }
    return total;
  }

  // ---- Bulk Import ----

  /** Import all listing_records into the success_copy collection. */
  async importSuccessfulListings(): Promise<number> {
    if (!this.enabled || !this.store || !this.db) return 0;

    const rows = await this.db.all<{ id: string; source_url: string; result_json: string }>(
      "SELECT id, source_url, result_json FROM listing_records WHERE status = 'done' OR status = 'published'"
    );
    let imported = 0;
    for (const row of rows) {
      try {
        const result = JSON.parse(row.result_json || "{}") as Record<string, unknown>;
        const title = (result.titleRu as string) || (result.title as string) || "";
        const desc = (result.descriptionRu as string) || (result.description as string) || "";
        const content = `商品标题: ${title}\n商品描述: ${desc}\n1688链接: ${row.source_url}`;
        if (title) {
          await this.index({ collection: "success_copy", id: row.id, content, metadata: { sourceUrl: row.source_url } });
          imported++;
        }
      } catch { /* skip unparseable */ }
    }
    logger.info({ imported, total: rows.length }, "RAG v2: imported successful listings");
    return imported;
  }

  /** Import category tree into ozon_categories collection. */
  async importCategoryTree(categoryTreeJson: string): Promise<number> {
    if (!this.enabled || !this.store) return 0;
    await this.store.deleteByCollection("ozon_categories");
    try {
      const tree = JSON.parse(categoryTreeJson) as Array<{ categoryId: number; title: string }>;
      const content = tree.map((c) => `[${c.categoryId}] ${c.title}`).join("\n");
      const count = await this.index({ collection: "ozon_categories", id: "ozon_category_tree", content, metadata: { type: "category_tree" } });
      return count;
    } catch (err) {
      logger.error({ err: (err as Error).message }, "RAG v2: import category tree failed");
      return 0;
    }
  }

  /** Import platform rules into platform_rules collection. */
  async importPlatformRules(rules: Array<{ id: string; title: string; content: string }>): Promise<number> {
    if (!this.enabled || !this.store) return 0;
    await this.store.deleteByCollection("platform_rules");
    let imported = 0;
    for (const rule of rules) {
      const text = `${rule.title}\n${rule.content}`;
      const count = await this.index({ collection: "platform_rules", id: rule.id, content: text, metadata: { title: rule.title } });
      imported += count;
    }
    return imported;
  }

  // ---- Auto-Index Hook (called after successful listing) ----

  /** Called after a product is successfully listed on Ozon. */
  async onListingSuccess(listingId: string, titleRu: string, descriptionRu: string, sourceUrl: string, categoryId?: number): Promise<void> {
    if (!this.enabled) return;
    const content = `商品标题: ${titleRu}\n商品描述: ${descriptionRu}\n1688链接: ${sourceUrl}${categoryId ? `\n类目ID: ${categoryId}` : ""}`;
    await this.index({
      collection: "success_copy",
      id: `listing_${listingId}`,
      content,
      metadata: { sourceUrl, categoryId: String(categoryId || "") },
    });
    logger.info({ listingId }, "RAG v2: auto-indexed listing");
  }

  // ---- Stats ----

  getStats(): RagStats {
    const base: RagStats = {
      enabled: this.enabled,
      store: this.store ? "sqlite" : "none",
      totalDocs: 0, totalBytes: 0,
      byCollection: {},
      avgSearchMs: this.searchTimings.length > 0
        ? Math.round(this.searchTimings.reduce((a, b) => a + b, 0) / this.searchTimings.length)
        : 0,
      searchCount: this.searchCount,
      embeddingModel: process.env.EMBEDDING_MODEL || "embedding-3",
      embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || "2048", 10),
    };
    return base;
  }

  async refreshStats(): Promise<RagStats> {
    const base = this.getStats();
    if (this.store) {
      try {
        const s = await this.store.getStats();
        base.totalDocs = s.totalDocs;
        base.totalBytes = s.totalBytes;
        base.byCollection = s.byCollection;
      } catch { /* store unavailable */ }
    }
    return base;
  }

  // Re-export utilities
  static chunkText = chunkText;
  static estimateChunkCount = estimateChunkCount;
  static estimateTokens = estimateTokens;
  static truncateContext = truncateContext;
  static countMessageTokens = countMessageTokens;
}