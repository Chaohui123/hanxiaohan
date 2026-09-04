// 库存域 api + hooks — 库存行级列表、补货预警
import { useQuery } from "@tanstack/react-query";
import { api, unwrapData } from "./client";

// ---- Types ----

export type InventoryItem = {
  offer_id?: string;
  sku?: number | string;
  name?: string;
  stock_available?: number;
  stock_reserved?: number;
  cost_cny?: number;
  weight_kg?: number;
  updated_at?: string | null;
};

export type InventoryAlertRow = {
  sku?: number | string;
  offerId?: string;
  name?: string;
  currentStock?: number;
  stockAvailable?: number;
  suggestedOrderQuantity?: number;
  alertLevel?: string;
};

// ---- API Methods ----

export const inventoryApi = {
  // /api/inventory/items 返回 { data: rows }（无 success 键），unwrapData 同样适用
  items: () => unwrapData<InventoryItem[]>(api.get("/api/inventory/items")),
  alerts: () => unwrapData<InventoryAlertRow[]>(api.get("/api/inventory/alerts")),
};

// ---- React Query Hooks ----

export function useInventoryItems() {
  return useQuery({ queryKey: ["inventory"], queryFn: () => inventoryApi.items() });
}

/** 库存预警（库存页补货建议 + Dashboard 行动清单计数共用） */
export function useInventoryAlerts() {
  return useQuery({ queryKey: ["inventory-alerts"], queryFn: () => inventoryApi.alerts(), refetchInterval: 60_000 });
}
