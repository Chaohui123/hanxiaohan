// 订单域 api + hooks — 订单列表/同步/发货/对账
import { useQuery } from "@tanstack/react-query";
import { api, unwrapData } from "./client";

// ---- Types ----

export interface OrderProduct {
  sku: number;
  quantity: number;
  offerId?: string;
  price?: string;
}

export interface OrderRow {
  id: string;
  posting_number: string;
  order_id: number;
  status: string;
  total_price_rub: number;
  product_count: number;
  tracking_number?: string;
  raw_json?: string;
  products_json?: string; // ozon_orders 的商品明细（webhook local_orders 用 raw_json）
  created_at: string;
  shipmentDeadline?: string | null;
}

export interface ReconcileDiscrepancy {
  orderId: string;
  localPayout: number;
  ozonPayout: number;
  difference: number;
  reason?: string;
}

export interface ReconcileView {
  dateFrom: string;
  dateTo: string;
  createdAt?: string;
  totalOrders: number;
  matched: number;
  missingLocal: number;
  missingOzon: number;
  discrepancies: ReconcileDiscrepancy[];
}

/** reconciliation_results 表行（后端已把 result_json 解析为对象） */
export type ReconcileRow = {
  date_from?: string;
  date_to?: string;
  created_at?: string;
  total_orders?: number;
  matched?: number;
  missing_local?: number;
  missing_ozon?: number;
  result_json?: {
    totalOrders?: number;
    matched?: number;
    missingLocal?: number;
    missingOzon?: number;
    discrepancies?: ReconcileDiscrepancy[];
  };
};

/** 顶层 discrepancies 是计数，明细在 result_json 里 */
export function normalizeReconcile(row: ReconcileRow | null | undefined): ReconcileView | null {
  if (!row) return null;
  const rj = row.result_json ?? {};
  return {
    dateFrom: row.date_from ?? "",
    dateTo: row.date_to ?? "",
    createdAt: row.created_at,
    totalOrders: rj.totalOrders ?? Number(row.total_orders) ?? 0,
    matched: rj.matched ?? Number(row.matched) ?? 0,
    missingLocal: rj.missingLocal ?? Number(row.missing_local) ?? 0,
    missingOzon: rj.missingOzon ?? Number(row.missing_ozon) ?? 0,
    discrepancies: Array.isArray(rj.discrepancies) ? rj.discrepancies : [],
  };
}

// ---- API Methods（{success, data} 信封在此脱壳；页面忽略响应体的写操作不脱）----

export const orderApi = {
  list: (status?: string) => unwrapData<OrderRow[]>(api.get("/api/orders", { params: { status } })),
  sync: (params?: Record<string, unknown>) => api.post("/api/orders/sync", params || {}),
  ship: (postingNumber: string, trackingNumber: string, products: Array<{ sku: number; quantity: number }>) =>
    api.post("/api/orders/ship", { postingNumber, trackingNumber, products }),
  batchShip: () =>
    unwrapData<{ total?: number; shipped?: number }>(api.post("/api/orders/batch-ship", {})),
  reconcile: (dateFrom: string, dateTo: string) => api.post("/api/orders/reconcile", { dateFrom, dateTo }),
  reconcileLatest: () => unwrapData<ReconcileRow | null>(api.get("/api/orders/reconcile/latest")),
};

// ---- React Query Hooks ----

/** 订单列表（后端 LIMIT 100 全量，前端按状态分组）；不传 status 即全部 */
export function useOrders(status?: string) {
  return useQuery({
    queryKey: ["orders", status || "all"],
    queryFn: () => orderApi.list(status),
  });
}

/** 待发货订单（Dashboard 行动清单的临近超时筛选） */
export function useAwaitingDeliverOrders() {
  return useQuery({
    queryKey: ["orders", "awaiting_deliver"],
    queryFn: () => orderApi.list("awaiting_deliver"),
    refetchInterval: 60_000,
  });
}
