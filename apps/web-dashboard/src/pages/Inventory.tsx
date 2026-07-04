import { Card, Table, Tag } from "antd";
import { inventoryApi } from "../api/client";
import { useQuery } from "@tanstack/react-query";

export default function Inventory() {
  const { data, isLoading } = useQuery({ queryKey: ["inventory"], queryFn: () => inventoryApi.items() });
  const { data: alerts } = useQuery({ queryKey: ["alerts"], queryFn: () => inventoryApi.alerts() });

  const items = (Array.isArray((data as { data?: unknown[] })?.data) ? (data as { data: unknown[] }).data : []);
  const alertList = (Array.isArray((alerts as { data?: unknown[] })?.data) ? (alerts as { data: unknown[] }).data : []);

  return (
    <div>
      <Card title="库存列表" style={{ marginBottom: 16 }}>
        <Table dataSource={items} rowKey={(r: Record<string,unknown>) => `${r.offer_id}-${r.sku}`} loading={isLoading} size="small"
          columns={[
            { title: "SKU", dataIndex: "sku" }, { title: "Offer ID", dataIndex: "offer_id", ellipsis: true },
            { title: "可用", dataIndex: "stock_available", render: (v: number) => <Tag color={v < 5 ? "red" : "green"}>{v}</Tag> },
            { title: "预留", dataIndex: "stock_reserved" },
          ]}
        />
      </Card>
      <Card title="补货建议">
        <Table dataSource={alertList} rowKey="sku" size="small" locale={{ emptyText: "✅ 库存充足" }}
          columns={[
            { title: "SKU", dataIndex: "sku" }, { title: "当前库存", dataIndex: "currentStock" },
            { title: "建议补货", dataIndex: "suggestedOrderQuantity" },
            { title: "级别", dataIndex: "alertLevel", render: (l: string) => <Tag color={l === "critical" ? "red" : "orange"}>{l}</Tag> },
          ]}
        />
      </Card>
    </div>
  );
}
