// 任务域 api + hooks — 队列统计、失败/死信任务、上架记录
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrapData } from "./client";

// ---- Types（后端 DTO 同时带 camelCase 与 snake_case 键，type 别名保留隐式索引签名）----

export type QueueStats = {
  queued?: number;
  processing?: number;
  done?: number;
  failed?: number;
  total?: number;
  deadLetterPending?: number;
};

export type FailedTaskRow = {
  id: string;
  status?: string;
  category?: string;
  taskType?: string; task_type?: string;
  storeId?: string; store_id?: string;
  errorMessage?: string; error_message?: string;
  retryCount?: number; retry_count?: number;
  maxRetries?: number; max_retries?: number;
  createdAt?: string; created_at?: string;
};

export type ListingRecord = {
  id: string | number;
  sourceUrl?: string;
  source?: string;
  status?: string;
  draftId?: string | number;
  createdAt?: string;
};

export type RetryBatchResult = { retried?: number; failed?: number; total?: number };

// ---- API Methods（/api/task/* 均为 {success, data} 信封，统一在此脱壳）----

export const taskApi = {
  queueStats: () => unwrapData<QueueStats>(api.get("/api/task/queue/stats")),
  failed: (params?: { storeId?: string; limit?: number }) =>
    unwrapData<FailedTaskRow[]>(api.get("/api/task/failed", { params })),
  retry: (taskId: string) => api.post(`/api/task/retry/${taskId}`),
  retryBatch: (filterType: string) =>
    unwrapData<RetryBatchResult>(api.post("/api/task/deadletter/retry-batch", { filterType })),
  listings: () => unwrapData<ListingRecord[]>(api.get("/api/task/listings")),
};

// ---- React Query Hooks ----

export function useQueueStats() {
  return useQuery({ queryKey: ["queue"], queryFn: () => taskApi.queueStats(), refetchInterval: 15_000 });
}

/** 失败/死信任务（Dashboard 行动清单、Monitoring 死信卡共用） */
export function useFailedTasks() {
  return useQuery({ queryKey: ["failed-tasks"], queryFn: () => taskApi.failed(), refetchInterval: 30_000 });
}

/** 失败任务页（/tasks?tab=failed），带 limit */
export function useFailedProducts() {
  return useQuery({ queryKey: ["failed-products"], queryFn: () => taskApi.failed({ limit: 200 }), refetchInterval: 15_000 });
}

export function useTaskListings() {
  return useQuery({ queryKey: ["task-listings"], queryFn: () => taskApi.listings() });
}

/** 单个重跑；invalidateKey 为调用方所在列表的 queryKey 前缀 */
export function useRetryTask(invalidateKey: string[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => taskApi.retry(taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey: invalidateKey }),
  });
}

export function useRetryBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (filterType: string) => taskApi.retryBatch(filterType),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["failed-products"] }),
  });
}
