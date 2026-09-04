// 大盘分析域 api + hooks — 每日快照详情、快照列表、手动触发分析
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrapData } from "./client";

// ---- Types ----

export type SnapshotItem = { id: string; date: string; listed_count: number; created_at: string };
export type CategoryItem = { name: string; sales: number; margin: number; competition: string; label: string; traffic: number };
export type ProductItem = { title: string; url: string; price: number; score: number; monthlySales: number; rating: number; profit: number };
export type KeywordItem = { word: string; volume: number; cpc: number; competition: string; products: number; tag: string };
export type CostItem = { category: string; amount: number; percent: number };
export type CompetitorItem = { name: string; price: number; sales: number; rating: number; advantage: string };

export interface MarketDetail {
  date: string;
  listedCount: number;
  llmReport: string;
  overview: { totalSales: number; avgMargin: number; blueOceanCount: number; pendingAdjust: number; avgCpc: number };
  categories: CategoryItem[];
  products: ProductItem[];
  keywords: KeywordItem[];
  costs: CostItem[];
  competitors: CompetitorItem[];
}

// ---- API Methods ----

export const marketApi = {
  detail: (date: string) => unwrapData<MarketDetail>(api.get(`/api/market/detail/${date}`)),
  listSnapshots: () => unwrapData<SnapshotItem[]>(api.get("/api/market/list-snapshot")),
  runAnalysis: () => unwrapData<{ id?: string; status?: string }>(api.post("/api/task/run-market")),
};

// ---- React Query Hooks ----

/** 按日期查询大盘详情；queryKey 含日期，切换日期天然隔离缓存，无需手动防 stale 覆盖 */
export function useMarketDetail(date: string) {
  return useQuery({ queryKey: ["market-detail", date], queryFn: () => marketApi.detail(date) });
}

export function useMarketSnapshots() {
  return useQuery({ queryKey: ["market-snapshots"], queryFn: () => marketApi.listSnapshots() });
}

export function useRunMarket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => marketApi.runAnalysis(),
    // 后端分析任务是异步的，延迟 5s 刷新详情（沿用原页面行为）
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["market-detail"] }), 5000),
  });
}
