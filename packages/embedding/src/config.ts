export interface EmbeddingConfig {
  provider: "deepseek" | "zhipu" | "openai" | "local";
  model: string;
  dimensions: number;
  baseUrl: string;
  apiKey: string;
  maxBatchSize: number;
  maxRetries: number;
  requestTimeoutMs: number;
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const provider = (process.env.EMBEDDING_PROVIDER || "zhipu") as EmbeddingConfig["provider"];
  return {
    provider,
    model: process.env.EMBEDDING_MODEL || "embedding-3",
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || "2048", 10),
    baseUrl: process.env.EMBEDDING_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    apiKey: process.env.EMBEDDING_API_KEY || process.env.KIMI_API_KEY || "",
    maxBatchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || "16", 10),
    maxRetries: 3,
    requestTimeoutMs: parseInt(process.env.EMBEDDING_TIMEOUT_MS || "30000", 10),
  };
}
