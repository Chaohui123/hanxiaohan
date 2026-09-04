// Dashboard workbench hooks — KPI 卡、行动清单、近 7 日趋势的真实数据源
import { useQuery } from "@tanstack/react-query";
import { api, orderApi, taskApi, inventoryApi } from "./client";

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

export interface FailedTaskItem {
  id: number | string;
  taskType?: string;
  errorMessage?: string;
  status?: string;
}

export interface InventoryAlertItem {
  offerId?: string;
  name?: string;
  stockAvailable?: number;
}

export interface AwaitingOrderItem {
  posting_number: string;
  status: string;
  shipmentDeadline: string | null;
}

// ---- React Query Hooks ----

/** 近 7 日销售趋势（daily_sales 真实数据）；from/to 为 YYYY-MM-DD，缺省由后端定近 7 天 */
export function useWeeklyStats(from?: string, to?: string) {
  return useQuery({
    queryKey: ["stats-weekly", from || "", to || ""],
    queryFn: () => api.get("/api/stats/weekly", { params: { from, to } }) as unknown as Promise<WeeklyStats>,
    refetchInterval: 60_000,
  });
}

/** 失败/死信任务列表（行动清单计数 + /tasks?tab=failed 入口） */
export function useFailedTasks() {
  return useQuery({
    queryKey: ["failed-tasks"],
    queryFn: () => taskApi.failed() as unknown as Promise<{ data: FailedTaskItem[] }>,
    refetchInterval: 60_000,
  });
}

/** 库存预警列表（行动清单计数 + /inventory 入口） */
export function useInventoryAlerts() {
  return useQuery({
    queryKey: ["inventory-alerts"],
    queryFn: () => inventoryApi.alerts() as unknown as Promise<{ data: InventoryAlertItem[] }>,
    refetchInterval: 60_000,
  });
}

/** 待发货订单（含 shipmentDeadline，用于临近超时筛选） */
export function useAwaitingDeliverOrders() {
  return useQuery({
    queryKey: ["awaiting-deliver-orders"],
    queryFn: () => orderApi.list("awaiting_deliver") as unknown as Promise<{ data: AwaitingOrderItem[] }>,
    refetchInterval: 60_000,
  });
}
