// ============================================================
// Shared RAG Client — unified query + write-back for all agents
// ============================================================

import { logger } from "@onzo/logger";

export interface RagConfig {
  apiBase: string;
  apiKey: string;
}

export interface RagSearchResult {
  content: string;
  score: number;
  [key: string]: unknown;
}

/**
 * Query any RAG knowledge base. All agents use this single function.
 */
export async function queryRag(
  config: RagConfig,
  kb: "aftersales" | "competitor" | "product" | "copy" | "playbook",
  query: string,
  options?: {
    scenario?: string;
    category?: string;
    offerId?: string;
    topK?: number;
    timeout?: number;
    minScore?: number;
  },
): Promise<RagSearchResult[]> {
  const extra: Record<string, unknown> = {};
  if (options?.scenario) extra.scenario = options.scenario;
  if (options?.category) extra.category = options.category;
  if (options?.offerId) extra.offerId = options.offerId;

  try {
    const resp = await fetch(`${config.apiBase}/api/rag/${kb}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify({ query, topK: options?.topK || 3, ...extra }),
      signal: AbortSignal.timeout(options?.timeout || 10_000),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { results?: RagSearchResult[] };
    const minScore = options?.minScore ?? parseFloat(process.env.RAG_SIMILARITY_THRESHOLD || "0.7");
    return (data.results || []).filter((r) => (r.score || 0) >= minScore);
  } catch (err) {
    logger.warn({ kb, query: query.slice(0, 50), err: (err as Error).message }, `RAG ${kb} query degraded`);
    return [];
  }
}

/**
 * Split long text into overlapping chunks at sentence boundaries.
 * Default chunkSize=10KB (~2500 tokens), overlap=10% for context continuity.
 */
export function chunkText(
  text: string,
  chunkSize = 10_000,
  overlap = 1_000,
): Array<{ text: string; index: number }> {
  if (text.length <= chunkSize) return [{ text, index: 0 }];
  const sentences = text.split(/(?<=[。！？.!?\n])/);
  const chunks: Array<{ text: string; index: number }> = [];
  let current = "";
  let idx = 0;
  for (const sentence of sentences) {
    if ((current + sentence).length > chunkSize && current.length > 0) {
      chunks.push({ text: current.trim(), index: idx++ });
      current = current.slice(-overlap).trimStart() + sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push({ text: current.trim(), index: idx });
  return chunks;
}

/**
 * Extract content string from search results.
 */
export function extractRagContent(results: RagSearchResult[], limit = 100): string {
  if (!results.length) return "";
  return results.map((r) => r.content.slice(0, limit)).join("\n");
}

/**
 * Write back to any RAG knowledge base (fire-and-forget).
 */
export function writeRag(
  config: RagConfig,
  kb: "aftersales" | "competitor" | "product" | "copy" | "playbook",
  data: Record<string, unknown>,
): void {
  fetch(`${config.apiBase}/api/rag/${kb}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {}); // fire-and-forget
}
