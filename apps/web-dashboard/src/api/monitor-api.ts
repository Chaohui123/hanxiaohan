// 监控域 api + hooks — Token 用量、汇率、爬虫指标、管道健康
import { useQuery } from "@tanstack/react-query";
import { api, unwrapData } from "./client";

// ---- Types ----

export type LlmStats = {
  todayTokens?: number;
  todayCost?: number;
  monthTokens?: number;
  dailyLimit?: number;
  breakdown?: unknown[];
};

/** GET /api/stores/fx 为裸对象返回（无 success/data 包装） */
export type FxRate = {
  rate?: number;
  cached?: boolean;
  source?: string;
  reliable?: boolean;
};

export type ScraperMetrics = {
  successRate?: string | number;
  [key: string]: unknown;
};

export type PipelineComponent = { name: string; status: string; latencyMs: number };

/** GET /ready/pipeline 为裸对象返回 */
export type PipelineHealth = {
  status?: string;
  components?: PipelineComponent[];
};

// ---- API Methods ----

export const monitorApi = {
  llmStats: () => unwrapData<LlmStats>(api.get("/api/stats/llm")),
  fxRate: () => api.get("/api/stores/fx") as unknown as Promise<FxRate>,
  scraperMetrics: () => unwrapData<ScraperMetrics>(api.get("/api/debug/scraper-metrics")),
  pipelineHealth: () => api.get("/ready/pipeline") as unknown as Promise<PipelineHealth>,
};

// ---- React Query Hooks ----

export function useLlmStats() {
  return useQuery({ queryKey: ["llm-stats"], queryFn: () => monitorApi.llmStats(), refetchInterval: 30_000 });
}

export function useFxRate() {
  return useQuery({ queryKey: ["fx"], queryFn: () => monitorApi.fxRate(), refetchInterval: 60_000 });
}

export function useScraperMetrics() {
  return useQuery({ queryKey: ["scraper-metrics"], queryFn: () => monitorApi.scraperMetrics(), refetchInterval: 30_000 });
}

export function usePipelineHealth() {
  return useQuery({ queryKey: ["pipeline-health"], queryFn: () => monitorApi.pipelineHealth(), refetchInterval: 60_000 });
}
