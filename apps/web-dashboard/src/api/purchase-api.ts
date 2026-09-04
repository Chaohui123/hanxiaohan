// 采购支付域 api + hooks — 支付单列表、日账单、支付/重试/编辑、跨境巴士导出
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapData } from "./client";

// ---- Types ----

export type PurchaseRecord = {
  id: string;
  ozon_posting_number?: string;
  payment_status?: string;
  pay_channel?: string;
  total_amount_cny?: number;
  logistics_status?: string;
  logistics_tracking?: string;
  logistics_carrier?: string;
  pay_time?: string;
  pay_serial?: string;
  freight_address?: string;
  source_1688_url?: string;
  created_at?: string;
};

export type PurchaseBill = { totalCny?: number; count?: number };

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
    unwrapData<PurchaseRecord[]>(api.get("/api/purchase/list", { params })),

  batchPay: (storeId?: string) => api.post("/api/purchase/batch-pay", { storeId }),

  dailyBill: (date?: string) => unwrapData<PurchaseBill>(api.get("/api/finance/purchase-bill", { params: { date } })),

  update: (id: string, data: {
    paymentStatus?: string; paySerial?: string; payTime?: string;
    logisticsStatus?: string; logisticsTracking?: string; logisticsCarrier?: string;
  }) => api.put(`/api/purchase/${id}`, data),

  /** 跨境巴士 xlsx 导出：响应是二进制流，blob 下载后由页面触发浏览器保存 */
  exportKuajingbus: (ids: Array<string | number>) =>
    api.post("/api/logistics/export-kuajingbus", { ids }, { responseType: "blob" }) as unknown as Promise<Blob>,
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

export function useUpdateMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; paymentStatus?: string; paySerial?: string; payTime?: string; logisticsStatus?: string; logisticsTracking?: string; logisticsCarrier?: string }) =>
      purchaseApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["purchase-list"] }); },
  });
}
