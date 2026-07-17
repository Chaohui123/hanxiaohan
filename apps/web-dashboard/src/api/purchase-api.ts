import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

// ---- API calls ----

export const purchaseApi = {
  pay: (data: {
    postingNumber: string; storeId?: string; costCny: number; sellingPriceRub: number;
    weightKg?: number; source1688Url?: string;
    skuList: Array<{ sku: number; quantity: number; unitPriceCny: number }>;
    ozonOrderId: number; offerId?: string;
  }) => api.post("/api/purchase/pay", data),

  retry: (id: string) => api.post(`/api/purchase/retry/${id}`),

  status: (postingNumber: string) => api.get(`/api/purchase/status/${postingNumber}`),

  list: (params?: { status?: string; storeId?: string; limit?: number }) =>
    api.get("/api/purchase/list", { params }),

  batchPay: (storeId?: string) => api.post("/api/purchase/batch-pay", { storeId }),

  dailyBill: (date?: string) => api.get("/api/finance/purchase-bill", { params: { date } }),
};

// ---- React Query hooks ----

export function usePurchaseList(status?: string) {
  return useQuery({
    queryKey: ["purchase-list", status],
    queryFn: () => purchaseApi.list({ status, limit: 100 }),
    refetchInterval: 15_000,
  });
}

export function usePurchaseBill(date?: string) {
  return useQuery({
    queryKey: ["purchase-bill", date],
    queryFn: () => purchaseApi.dailyBill(date),
    refetchInterval: 30_000,
  });
}

export function usePayMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: purchaseApi.pay,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["purchase-list"] }); },
  });
}

export function useRetryMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: purchaseApi.retry,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["purchase-list"] }); },
  });
}