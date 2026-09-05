export interface EmbeddingConfig {
  provider: "deepseek" | "zhipu" | "openai" | "local" | "kimi";
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
  // provider 默认端点：kimi = Kimi bge_m3_embed（1024 维）；zhipu = 智谱 embedding-3（2048 维）
  const defaults = provider === "kimi"
    ? { model: "bge_m3_embed", dimensions: 1024, baseUrl: "https://api.kimi.com/coding/v1" }
    : { model: "embedding-3", dimensions: 2048, baseUrl: "https://open.bigmodel.cn/api/paas/v4" };
  return {
    provider,
    model: process.env.EMBEDDING_MODEL || defaults.model,
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || String(defaults.dimensions), 10),
    baseUrl: process.env.EMBEDDING_BASE_URL || defaults.baseUrl,
    apiKey: process.env.EMBEDDING_API_KEY || process.env.KIMI_API_KEY || "",
    maxBatchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || "16", 10),
    maxRetries: 3,
    requestTimeoutMs: parseInt(process.env.EMBEDDING_TIMEOUT_MS || "30000", 10),
  };
}
