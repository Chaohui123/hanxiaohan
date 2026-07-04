import { useState } from "react";
import { Card, Table, Tag, Button, Select, Space, message } from "antd";
import { ReloadOutlined, SendOutlined } from "@ant-design/icons";
import { orderApi } from "../api/client";
import { useQuery } from "@tanstack/react-query";

export default function Orders() {
  const [status, setStatus] = useState<string>("");
  const { data, refetch, isLoading } = useQuery({ queryKey: ["orders", status], queryFn: () => orderApi.list(status || undefined) });

  const orders = (Array.isArray((data as { data?: unknown[] })?.data) ? (data as { data: unknown[] }).data : []);

  const handleSync = async () => {
    try { await orderApi.sync(); message.success("同步已启动"); refetch(); }
    catch (err) { message.error((err as Error).message); }
  };

  const handleShip = async (postingNumber: string) => {
    try {
      await orderApi.ship(postingNumber, `ONZO-${Date.now().toString(36)}`, [{ sku: 1, quantity: 1 }]);
      message.success("已标记发货"); refetch();
    } catch (err) { message.error((err as Error).message); }
  };

  return (
    <Card title="订单管理" extra={
      <Space>
        <Select placeholder="状态筛选" allowClear style={{ width: 160 }} value={status} onChange={setStatus}
          options={[
            { value: "awaiting_packaging", label: "待打包" }, { value: "awaiting_deliver", label: "待发货" },
            { value: "delivering", label: "运输中" }, { value: "delivered", label: "已签收" }, { value: "cancelled", label: "已取消" },
          ]} />
        <Button icon={<ReloadOutlined />} onClick={handleSync}>同步订单</Button>
      </Space>
    }>
      <Table dataSource={orders} rowKey="id" loading={isLoading} size="small"
        columns={[
          { title: "订单号", dataIndex: "posting_number", width: 140 },
          { title: "状态", dataIndex: "status", render: (s: string) => <Tag>{s}</Tag>, width: 120 },
          { title: "金额", dataIndex: "total_price_rub", render: (v: number) => `${v} ₽`, width: 100 },
          { title: "件数", dataIndex: "product_count", width: 60 },
          { title: "物流", dataIndex: "tracking_number", ellipsis: true, width: 160 },
          { title: "操作", width: 100, render: (_: unknown, r: { status: string; posting_number: string }) =>
            r.status === "awaiting_deliver" ? <Button size="small" icon={<SendOutlined />} onClick={() => handleShip(r.posting_number)}>发货</Button> : null
          },
        ]}
      />
    </Card>
  );
}
