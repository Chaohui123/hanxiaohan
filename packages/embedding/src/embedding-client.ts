import { logger } from "@onzo/logger";
import { getEmbeddingConfig, type EmbeddingConfig } from "./config.js";

export interface EmbeddingResult {
  text: string;
  vector: number[];
  tokenCount: number;
}

export class EmbeddingClient {
  private config: EmbeddingConfig;
  private requestCount = 0;

  constructor(config?: Partial<EmbeddingConfig>) {
    this.config = { ...getEmbeddingConfig(), ...config };
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];
    if (texts.length > this.config.maxBatchSize) {
      const batches: EmbeddingResult[][] = [];
      for (let i = 0; i < texts.length; i += this.config.maxBatchSize) {
        batches.push(await this.embedBatch(texts.slice(i, i + this.config.maxBatchSize)));
      }
      return batches.flat();
    }

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const vectors = await this.callApi(texts);
        this.requestCount++;
        return texts.map((text, i) => ({
          text,
          vector: vectors[i],
          tokenCount: Math.ceil(text.length / 4),
        }));
      } catch (err) {
        if (attempt === this.config.maxRetries) throw err;
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        logger.warn({ attempt, delay, error: (err as Error).message }, "Embedding retry");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("Unreachable");
  }

  private async callApi(texts: string[]): Promise<number[][]> {
    const { provider, baseUrl, apiKey, model } = this.config;

    if (provider === "zhipu") {
      const resp = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!resp.ok) throw new Error(`Zhipu embedding API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json() as { data: Array<{ index: number; embedding: number[] }> };
      return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }

    if (provider === "deepseek") {
      logger.warn("DeepSeek has no embedding API, falling back to Zhipu");
      const resp = await fetch("https://open.bigmodel.cn/api/paas/v4/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "embedding-3", input: texts }),
      });
      if (!resp.ok) throw new Error(`Embedding fallback API ${resp.status}`);
      const data = await resp.json() as { data: Array<{ index: number; embedding: number[] }> };
      return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }

    if (provider === "local") {
      return texts.map((t) => this.localEmbed(t));
    }

    throw new Error(`Unknown embedding provider: ${provider}`);
  }

  private localEmbed(text: string): number[] {
    const dim = this.config.dimensions;
    const vec = new Array(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      const idx = text.charCodeAt(i) % dim;
      vec[idx] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  getRequestCount(): number {
    return this.requestCount;
  }
}
