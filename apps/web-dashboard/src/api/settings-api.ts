// 设置域 api + hooks — 店铺列表、1688 插件采集记录
import { useQuery } from "@tanstack/react-query";
import { api, unwrapData } from "./client";

// ---- Types ----

export type StoreRecord = {
  store_id: string;
  store_name?: string;
  name?: string;
  group_name?: string;
  active?: number;
  apiKey?: string;
};

export type PluginProduct = {
  title?: string;
  price_cny?: string;
  source_url?: string;
};

// ---- API Methods ----

export const storeApi = {
  list: () => unwrapData<StoreRecord[]>(api.get("/api/stores")),
};

export const pluginApi = {
  list: () => unwrapData<PluginProduct[]>(api.get("/api/crawl/plugin-list")),
};

// ---- React Query Hooks ----

/** 店铺列表（Header 切换器与设置页共用同一 queryKey 缓存） */
export function useStores() {
  return useQuery({ queryKey: ["stores"], queryFn: () => storeApi.list() });
}

export function usePluginProducts() {
  return useQuery({ queryKey: ["plugin-products"], queryFn: () => pluginApi.list(), refetchInterval: 15_000 });
}
