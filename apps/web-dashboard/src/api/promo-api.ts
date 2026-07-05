import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

// ---- API Methods ----

export const promoApi = {
  decision: () => api.get("/api/promo/decision"),
  salesRanking: (days = 7) => api.get("/api/promo/sales-ranking", { params: { days } }),
  cost: (from: string, to: string) => api.get("/api/promo/cost", { params: { from, to } }),
  watchList: () => api.get("/api/promo/watch-list"),
  addWatch: (offerId: string, name: string) => api.post("/api/promo/watch-list", { offerId, name }),
  removeWatch: (offerId: string) => api.delete(`/api/promo/watch-list/${offerId}`),
  competitorPrices: (offerId: string, days = 30) =>
    api.get(`/api/promo/competitor-prices/${offerId}`, { params: { days } }),
  events: (type?: string) => api.get("/api/promo/events", { params: { type } }),
  pricingHistory: (days = 30) => api.get("/api/promo/pricing-history", { params: { days } }),
  copyHistory: (days = 30) => api.get("/api/promo/copy-history", { params: { days } }),
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

export function useSalesRanking(days = 7) {
  return useQuery({ queryKey: ["promo-sales-ranking", days], queryFn: () => promoApi.salesRanking(days) });
}

export function usePromoCost(from?: string, to?: string) {
  const f = from || daysAgo(7);
  const t = to || today();
  return useQuery({ queryKey: ["promo-cost", f, t], queryFn: () => promoApi.cost(f, t) });
}

export function useWatchList() {
  return useQuery({ queryKey: ["promo-watch-list"], queryFn: () => promoApi.watchList() });
}

export function useCompetitorPrices(offerId: string, days = 30) {
  return useQuery({
    queryKey: ["promo-competitor-prices", offerId, days],
    queryFn: () => promoApi.competitorPrices(offerId, days),
    enabled: !!offerId,
  });
}

export function usePromoEvents(type?: string) {
  return useQuery({
    queryKey: ["promo-events", type],
    queryFn: () => promoApi.events(type),
    refetchInterval: 30_000,
  });
}

export function usePricingHistory(days = 30) {
  return useQuery({ queryKey: ["promo-pricing-history", days], queryFn: () => promoApi.pricingHistory(days) });
}

export function useCopyHistory(days = 30) {
  return useQuery({ queryKey: ["promo-copy-history", days], queryFn: () => promoApi.copyHistory(days) });
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
