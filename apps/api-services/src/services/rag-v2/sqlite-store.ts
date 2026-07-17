// ============================================================
// SQLite Vector Store — cosine similarity search on JSON vectors
// Compatible with existing SQLite architecture. No pgvector required.
// ============================================================

import type { DbAdapter } from "../../db/connection.js";

export interface VectorDoc {
  id: string;
  collection: string;
  content: string;
  metadata: Record<string, string>;
  vector: number[];
  tokenCount: number;
  byteLength: number;
  createdAt: string;
}

export interface SearchResult {
  doc: VectorDoc;
  similarity: number;
}

// ---- Cosine Similarity ----

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = dotProduct(a, b);
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

// ---- Store ----

export class SqliteVectorStore {
  constructor(private db: DbAdapter) {}

  async initSchema(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_v2_documents (
        id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT DEFAULT '{}',
        vector_json TEXT NOT NULL,
        token_count INTEGER DEFAULT 0,
        byte_length INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rag_v2_collection ON rag_v2_documents(collection);
    `);
  }

  async insert(doc: Omit<VectorDoc, "createdAt">): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO rag_v2_documents (id, collection, content, metadata_json, vector_json, token_count, byte_length, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [doc.id, doc.collection, doc.content, JSON.stringify(doc.metadata), JSON.stringify(doc.vector), doc.tokenCount, doc.byteLength]
    );
  }

  async insertBatch(docs: Omit<VectorDoc, "createdAt">[]): Promise<number> {
    let count = 0;
    for (const doc of docs) {
      await this.insert(doc);
      count++;
    }
    return count;
  }

  async search(
    collection: string,
    queryVector: number[],
    topK: number,
    similarityThreshold = 0.6
  ): Promise<SearchResult[]> {
    const rows = await this.db.all<{
      id: string; collection: string; content: string; metadata_json: string;
      vector_json: string; token_count: number; byte_length: number; created_at: string;
    }>(
      "SELECT * FROM rag_v2_documents WHERE collection = ?",
      [collection]
    );

    if (rows.length === 0) return [];

    const results: SearchResult[] = [];
    for (const row of rows) {
      const vector = JSON.parse(row.vector_json) as number[];
      const similarity = cosineSimilarity(queryVector, vector);
      if (similarity >= similarityThreshold) {
        results.push({
          doc: {
            id: row.id,
            collection: row.collection,
            content: row.content,
            metadata: JSON.parse(row.metadata_json) as Record<string, string>,
            vector,
            tokenCount: row.token_count,
            byteLength: row.byte_length,
            createdAt: row.created_at,
          },
          similarity: Math.round(similarity * 10000) / 10000,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  async getStats(): Promise<{
    totalDocs: number;
    totalBytes: number;
    byCollection: Record<string, { count: number; totalBytes: number }>;
  }> {
    const rows = await this.db.all<{ collection: string; cnt: number; bytes: number }>(
      "SELECT collection, COUNT(*) as cnt, SUM(byte_length) as bytes FROM rag_v2_documents GROUP BY collection"
    );
    const byCollection: Record<string, { count: number; totalBytes: number }> = {};
    let totalDocs = 0;
    let totalBytes = 0;
    for (const r of rows) {
      byCollection[r.collection] = { count: r.cnt, totalBytes: r.bytes };
      totalDocs += r.cnt;
      totalBytes += r.bytes;
    }
    return { totalDocs, totalBytes, byCollection };
  }

  async deleteByCollection(collection: string): Promise<number> {
    const result = await this.db.run("DELETE FROM rag_v2_documents WHERE collection = ?", [collection]);
    return result.changes;
  }

  async countByCollection(collection: string): Promise<number> {
    const rows = await this.db.all<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM rag_v2_documents WHERE collection = ?",
      [collection]
    );
    return rows[0]?.cnt || 0;
  }
}