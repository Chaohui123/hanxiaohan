import { logger } from "@onzo/logger";
import { getEmbeddingConfig } from "./config.js";
import { EmbeddingClient } from "./embedding-client.js";

export interface VectorDocument {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  vector?: number[];
}

export interface SearchResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

interface DbLike {
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export class PgVectorStore {
  private db: DbLike;
  private embeddingClient: EmbeddingClient;
  private tableName: string;

  constructor(db: DbLike, tableName: string, embeddingClient?: EmbeddingClient) {
    this.db = db;
    this.tableName = tableName;
    this.embeddingClient = embeddingClient || new EmbeddingClient();
  }

  async ensureTable(dimensions?: number): Promise<void> {
    const dim = dimensions || getEmbeddingConfig().dimensions;
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        metadata_json TEXT DEFAULT '{}',
        embedding vector(${dim}),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    try {
      await this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_embedding
        ON ${this.tableName} USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
      `);
    } catch { /* index may already exist or be unsupported */ }
    logger.info({ table: this.tableName, dim }, "Vector table ensured");
  }

  async upsert(doc: VectorDocument): Promise<void> {
    const vector = doc.vector || (await this.embeddingClient.embed(doc.content)).vector;
    const metadataJson = JSON.stringify(doc.metadata);
    const vecStr = `[${vector.join(",")}]`;
    await this.db.run(
      `INSERT INTO ${this.tableName} (id, content, metadata_json, embedding, updated_at)
       VALUES ($1, $2, $3, $4::vector, NOW())
       ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content,
         metadata_json = EXCLUDED.metadata_json,
         embedding = EXCLUDED.embedding,
         updated_at = NOW()`,
      [doc.id, doc.content, metadataJson, vecStr],
    );
  }

  async upsertBatch(docs: VectorDocument[]): Promise<void> {
    const texts = docs.filter((d) => !d.vector).map((d) => d.content);
    const embeddings = texts.length > 0 ? await this.embeddingClient.embedBatch(texts) : [];
    let embedIdx = 0;
    for (const doc of docs) {
      const vector = doc.vector || embeddings[embedIdx++].vector;
      await this.upsert({ ...doc, vector });
    }
  }

  async search(query: string, topK = 5, filter?: string): Promise<SearchResult[]> {
    const queryVector = (await this.embeddingClient.embed(query)).vector;
    const vecStr = `[${queryVector.join(",")}]`;
    const filterClause = filter ? `AND ${filter}` : "";
    const rows = await this.db.all(
      `SELECT id, content, metadata_json,
              1 - (embedding <=> $1::vector) AS score
       FROM ${this.tableName}
       WHERE 1=1 ${filterClause}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vecStr, topK],
    );

    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      content: r.content as string,
      metadata: JSON.parse((r.metadata_json as string) || "{}"),
      score: r.score as number,
    }));
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM ${this.tableName} WHERE id = $1`, [id]);
  }

  async count(): Promise<number> {
    const rows = await this.db.all<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${this.tableName}`);
    return rows[0]?.cnt || 0;
  }
}
