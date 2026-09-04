// Dashboard 域 api + hooks — 工作台统计、告警、COS、任务列表、近 7 日趋势
import { useQuery } from "@tanstack/react-query";
import { api, unwrapData } from "./client";

// ---- Types ----

export interface DailySalesPoint {
  date: string;
  orders: number;
  revenue: number;
}

/** GET /api/stats/weekly — 裸对象返回（无 success/data 包装） */
export interface WeeklyStats {
  orders: number;
  revenue: number;
  byDay: DailySalesPoint[];
  top5: Array<Record<string, unknown>>;
  bottom5: Array<Record<string, unknown>>;
}

export type DashboardStats = {
  todayTokens?: number;
  [key: string]: unknown;
};

export type AlertItem = { type: string; level: string; message: string; count: number };

export type CosStats = {
  totalImages?: number;
  deadLetter?: number;
  usagePercent?: number;
  estimatedBytes?: number;
  freeTierGB?: number;
};

/** /api/dashboard/tasks 行（task_queue 表直出） */
export type DashboardTaskRow = {
  id?: string | number;
  type?: string;
  status?: string;
  store_id?: string;
  retry_count?: number;
  max_retries?: number;
  error_message?: string;
};

// ---- API Methods ----

export const dashboardApi = {
  stats: () => unwrapData<DashboardStats>(api.get("/api/dashboard")),
  alerts: () => unwrapData<AlertItem[]>(api.get("/api/dashboard/alerts")),
  cosStats: () => unwrapData<CosStats>(api.get("/api/dashboard/cos")),
  taskList: (status: string, limit = 100) =>
    unwrapData<DashboardTaskRow[]>(api.get("/api/dashboard/tasks", { params: { status, limit } })),
  /** /health 无需鉴权，裸对象返回（登录页连通性检查用） */
  health: () => api.get("/health") as unknown as Promise<{ status?: string }>,
};

// ---- React Query Hooks ----

export function useDashboardStats() {
  return useQuery({ queryKey: ["dashboard"], queryFn: () => dashboardApi.stats(), refetchInterval: 15_000 });
}

/** Header 告警铃铛 */
export function useAlerts() {
  return useQuery({ queryKey: ["alerts"], queryFn: () => dashboardApi.alerts(), refetchInterval: 30_000 });
}

/** COS 用量（工作台行动清单的死信图片计数） */
export function useCosStats() {
  return useQuery({ queryKey: ["cos"], queryFn: () => dashboardApi.cosStats(), refetchInterval: 60_000 });
}

/** Ozon 导入任务监控（任务与失败 · 队列 Tab） */
export function useDashboardTasks(status = "all") {
  return useQuery({
    queryKey: ["dashboard-tasks", status],
    queryFn: () => dashboardApi.taskList(status),
    refetchInterval: 10_000,
  });
}

/** 近 7 日销售趋势（daily_sales 真实数据）；from/to 为 YYYY-MM-DD，缺省由后端定近 7 天 */
export function useWeeklyStats(from?: string, to?: string) {
  return useQuery({
    queryKey: ["stats-weekly", from || "", to || ""],
    queryFn: () => api.get("/api/stats/weekly", { params: { from, to } }) as unknown as Promise<WeeklyStats>,
    refetchInterval: 60_000,
  });
}
