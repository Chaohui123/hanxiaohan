// 推广域 api + hooks — 自主决策、成本、竞品监控、调价/文案历史
// 注意：/api/promo/* 与 /api/stats/weekly 均为裸对象返回（无 success/data 信封），
// 带命名键的（{items}/{events}/{prices}/{adjustments}/{copies}）在 hooks 里取键一次，页面拿到的就是最终数组。
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

// ---- Types ----

export interface DecisionStats {
  todayActions: number;
  weekActions: number;
  lastActionAt: string | null;
}

/** GET /api/promo/decision — 裸对象 */
export type PromoDecisionState = {
  autoEnabled: boolean | null;
  lastPlanId: string | null;
  lastPlanStatus: string | null;
  lastPlanCreatedAt?: string | null;
  lastPlanActionCount?: number;
  lastPlanExecutedAt?: string | null;
  agentReachable?: boolean;
};

/** GET /api/promo/cost — 裸对象 */
export type PromoCost = {
  adSpend?: number;
  paidRevenue?: number;
  roi?: number;
  organicRevenue?: number;
  totalRevenue?: number;
};

export type RankingItem = { offerId?: string; name?: string; orders?: number; revenue?: number };
export type WatchItem = { offerId?: string; name?: string };
export type CompetitorPrice = { capturedAt?: string; price?: number; rating?: number; salesCount?: number };
export type PromoEvent = { type?: string; payload?: Record<string, unknown>; createdAt?: string };
export type PricingAdjustment = {
  offerId?: string; name?: string; oldPrice?: number; newPrice?: number;
  reason?: string; salesBefore?: number; salesAfter?: number; appliedAt?: string;
};
export type CopyRecord = { offerId?: string; name?: string; titleRu?: string };
export type ProductSearchItem = { offerId: string; name: string; price: number; rating: number; salesCount: number };

// ---- API Methods ----

export const promoApi = {
  decision: () => api.get("/api/promo/decision") as unknown as Promise<PromoDecisionState>,
  decisionStats: () => api.get("/api/promo/decision-stats") as unknown as Promise<DecisionStats>,
  salesRanking: (days = 7) =>
    api.get("/api/promo/sales-ranking", { params: { days } }) as unknown as Promise<{ items: RankingItem[] }>,
  cost: (from: string, to: string) =>
    api.get("/api/promo/cost", { params: { from, to } }) as unknown as Promise<PromoCost>,
  watchList: () => api.get("/api/promo/watch-list") as unknown as Promise<{ items: WatchItem[] }>,
  addWatch: (offerId: string, name: string) => api.post("/api/promo/watch-list", { offerId, name }),
  removeWatch: (offerId: string) => api.delete(`/api/promo/watch-list/${offerId}`),
  competitorPrices: (offerId: string, days = 30) =>
    api.get(`/api/promo/competitor-prices/${offerId}`, { params: { days } }) as unknown as Promise<{ prices: CompetitorPrice[] }>,
  events: (type?: string) =>
    api.get("/api/promo/events", { params: { type } }) as unknown as Promise<{ events: PromoEvent[] }>,
  pricingHistory: (days = 30) =>
    api.get("/api/promo/pricing-history", { params: { days } }) as unknown as Promise<{ adjustments: PricingAdjustment[] }>,
  copyHistory: (days = 30) =>
    api.get("/api/promo/copy-history", { params: { days } }) as unknown as Promise<{ copies: CopyRecord[] }>,
  productSearch: (query: string, limit = 10) =>
    api.get("/api/promo/ozon/products/search", { params: { query, limit } }) as unknown as Promise<{ items: ProductSearchItem[] }>,
  autoDecisionOn: () => api.post("/api/promo/decision", { action: "on" }),
  autoDecisionOff: () => api.post("/api/promo/decision", { action: "off" }),
  triggerDecision: () => api.post("/api/promo/decision", { action: "run" }),
};

// ---- React Query Hooks ----

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

export function useDecision() {
  return useQuery({ queryKey: ["promo-decision"], queryFn: () => promoApi.decision(), refetchInterval: 60_000 });
}

export function useDecisionStats() {
  return useQuery({
    queryKey: ["promo-decision-stats"],
    queryFn: () => promoApi.decisionStats(),
    refetchInterval: 60_000,
  });
}

export function useSalesRanking(days = 7) {
  return useQuery({
    queryKey: ["promo-sales-ranking", days],
    queryFn: () => promoApi.salesRanking(days).then((r) => r.items),
  });
}

export function usePromoCost(from?: string, to?: string) {
  const f = from || daysAgo(7);
  const t = to || today();
  return useQuery({ queryKey: ["promo-cost", f, t], queryFn: () => promoApi.cost(f, t) });
}

export function useWatchList() {
  return useQuery({ queryKey: ["promo-watch-list"], queryFn: () => promoApi.watchList().then((r) => r.items) });
}

export function useCompetitorPrices(offerId: string, days = 30) {
  return useQuery({
    queryKey: ["promo-competitor-prices", offerId, days],
    queryFn: () => promoApi.competitorPrices(offerId, days).then((r) => r.prices),
    enabled: !!offerId,
  });
}

export function usePromoEvents(type?: string) {
  return useQuery({
    queryKey: ["promo-events", type],
    queryFn: () => promoApi.events(type).then((r) => r.events),
    refetchInterval: 30_000,
  });
}

export function usePricingHistory(days = 30) {
  return useQuery({
    queryKey: ["promo-pricing-history", days],
    queryFn: () => promoApi.pricingHistory(days).then((r) => r.adjustments),
  });
}

export function useCopyHistory(days = 30) {
  return useQuery({
    queryKey: ["promo-copy-history", days],
    queryFn: () => promoApi.copyHistory(days).then((r) => r.copies),
  });
}

/** Ctrl+K 全局搜索的商品结果（S7）：query 为空不发请求，调用方负责防抖 */
export function useProductSearch(query: string) {
  return useQuery({
    queryKey: ["promo-product-search", query],
    queryFn: () => promoApi.productSearch(query).then((r) => r.items),
    enabled: !!query,
    staleTime: 60_000,
  });
}

export function useAddWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ offerId, name }: { offerId: string; name: string }) => promoApi.addWatch(offerId, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["promo-watch-list"] }),
  });
}

export function useRemoveWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (offerId: string) => promoApi.removeWatch(offerId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["promo-watch-list"] }),
  });
}

export function useAutoDecisionToggle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enable: boolean) => enable ? promoApi.autoDecisionOn() : promoApi.autoDecisionOff(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["promo-decision"] }),
  });
}
