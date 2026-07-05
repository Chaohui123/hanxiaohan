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
      signal: AbortSignal.timeout(options?.timeout || 5_000),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { results?: RagSearchResult[] };
    const minScore = options?.minScore ?? 0.7;
    return (data.results || []).filter((r) => (r.score || 0) >= minScore);
  } catch (err) {
    logger.warn({ kb, query: query.slice(0, 50), err: (err as Error).message }, `RAG ${kb} query degraded`);
    return [];
  }
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
