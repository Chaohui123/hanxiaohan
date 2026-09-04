import { Card, Table, Tag } from "antd";
import { useInventoryItems, useInventoryAlerts } from "../api/inventory-api";
import PageContainer from "../components/PageContainer";
import QueryState from "../components/QueryState";

export default function Inventory() {
  const itemsQuery = useInventoryItems();
  const alertsQuery = useInventoryAlerts();

  return (
    <PageContainer title="库存与价格" subTitle="实时库存与补货建议" updatedAt={itemsQuery.dataUpdatedAt}>
      <Card title="库存列表" style={{ marginBottom: 16 }}>
        <QueryState query={itemsQuery} emptyText="还没有库存记录" emptyAction={{ label: "去选品上架", to: "/listing" }}>
          {(items) => (
            <Table dataSource={items} rowKey={(r) => `${String(r.offer_id)}-${String(r.sku)}`} size="small" scroll={{ x: "max-content" }}
              columns={[
                { title: "SKU", dataIndex: "sku" }, { title: "Offer ID", dataIndex: "offer_id", ellipsis: true },
                { title: "可用", dataIndex: "stock_available", render: (v: number) => <Tag color={v < 5 ? "red" : "green"}>{v}</Tag> },
                { title: "预留", dataIndex: "stock_reserved" },
              ]}
            />
          )}
        </QueryState>
      </Card>
      <Card title="补货建议">
        <QueryState query={alertsQuery} emptyText="✅ 库存充足，暂无补货建议">
          {(alertList) => (
            <Table dataSource={alertList} rowKey="sku" size="small" scroll={{ x: "max-content" }}
              columns={[
                { title: "SKU", dataIndex: "sku" }, { title: "当前库存", dataIndex: "currentStock" },
                { title: "建议补货", dataIndex: "suggestedOrderQuantity" },
                { title: "级别", dataIndex: "alertLevel", render: (l: string) => <Tag color={l === "critical" ? "red" : "orange"}>{l}</Tag> },
              ]}
            />
          )}
        </QueryState>
      </Card>
    </PageContainer>
  );
}
