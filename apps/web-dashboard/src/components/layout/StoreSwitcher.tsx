// StoreSwitcher — header store selector, persists selection to app-store.currentStore
import { useEffect } from "react";
import { Select } from "antd";
import { ShopOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { storeApi } from "../../api/client";
import { useAppStore } from "../../stores/app-store";

interface StoreRecord {
  store_id: string;
  store_name?: string;
  name?: string;
  active?: number;
}

const storeLabel = (s: StoreRecord) => s.store_name || s.name || s.store_id;

export default function StoreSwitcher() {
  const { currentStore, setCurrentStore } = useAppStore();
  const { data } = useQuery({ queryKey: ["stores"], queryFn: () => storeApi.list() });
  const stores: StoreRecord[] = Array.isArray((data as { data?: unknown[] })?.data)
    ? (data as { data: StoreRecord[] }).data
    : [];

  // Keep currentStore valid: default to the first store when unset or stale
  useEffect(() => {
    if (stores.length === 0) return;
    if (!currentStore || !stores.some((s) => s.store_id === currentStore)) {
      setCurrentStore(stores[0].store_id);
    }
  }, [stores, currentStore, setCurrentStore]);

  if (stores.length <= 1) {
    return (
      <Select
        size="small"
        disabled
        style={{ minWidth: 140 }}
        value={stores[0] ? storeLabel(stores[0]) : undefined}
        placeholder="无店铺"
        suffixIcon={<ShopOutlined />}
      />
    );
  }

  return (
    <Select
      size="small"
      style={{ minWidth: 160 }}
      value={currentStore || undefined}
      placeholder="选择店铺"
      suffixIcon={<ShopOutlined />}
      onChange={(v) => setCurrentStore(v)}
      options={stores.map((s) => ({ value: s.store_id, label: storeLabel(s) }))}
    />
  );
}
