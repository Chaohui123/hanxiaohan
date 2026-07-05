import { useState } from "react";
import { Card, Table, Tag, Button, Select, Space, message, Modal, Input, InputNumber, Popconfirm } from "antd";
import { ReloadOutlined, SendOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { orderApi } from "../api/client";
import { useQuery } from "@tanstack/react-query";

interface OrderProduct {
  sku: number;
  quantity: number;
  offerId?: string;
  price?: string;
}

interface OrderRow {
  id: string;
  posting_number: string;
  order_id: number;
  status: string;
  total_price_rub: number;
  product_count: number;
  tracking_number?: string;
  raw_json?: string;
  created_at: string;
}

/** Parse products from order raw_json. Expected format: { products: [{ sku, quantity, offer_id, price }] } */
function parseProducts(row: OrderRow): OrderProduct[] {
  try {
    const raw = typeof row.raw_json === "string" ? JSON.parse(row.raw_json) : row.raw_json;
    if (raw?.products && Array.isArray(raw.products)) {
      return raw.products.map((p: Record<string, unknown>) => ({
        sku: (p.sku ?? p.offer_id ?? 0) as number,
        quantity: (p.quantity ?? 1) as number,
        offerId: p.offer_id as string | undefined,
        price: p.price as string | undefined,
      }));
    }
  } catch { /* raw_json parse failed — fall through */ }

  // Fallback: synthetic product from product_count
  return row.product_count > 0
    ? Array.from({ length: row.product_count }, (_, i) => ({ sku: 0, quantity: 1, offerId: `item-${i + 1}` }))
    : [];
}

export default function Orders() {
  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [shipModalOpen, setShipModalOpen] = useState(false);
  const [shipTarget, setShipTarget] = useState<OrderRow | null>(null);
  const [trackingNumber, setTrackingNumber] = useState("");
  const [shipProducts, setShipProducts] = useState<OrderProduct[]>([]);

  const { data, refetch, isLoading } = useQuery({
    queryKey: ["orders", status],
    queryFn: () => orderApi.list(status || undefined),
  });

  const orders = (Array.isArray((data as { data?: OrderRow[] })?.data)
    ? (data as { data: OrderRow[] }).data
    : []) as OrderRow[];

  const handleSync = async () => {
    try { await orderApi.sync(); message.success("同步已启动"); refetch(); }
    catch (err) { message.error((err as Error).message); }
  };

  const openShipModal = (row: OrderRow) => {
    const products = parseProducts(row);
    setShipTarget(row);
    setShipProducts(products);
    setTrackingNumber(row.tracking_number || `ONZO-${Date.now().toString(36).toUpperCase()}`);
    setShipModalOpen(true);
  };

  const handleShip = async () => {
    if (!shipTarget) return;
    if (!trackingNumber.trim()) { message.warning("请输入物流单号"); return; }
    try {
      await orderApi.ship(shipTarget.posting_number, trackingNumber.trim(), shipProducts);
      message.success("已标记发货");
      setShipModalOpen(false);
      setShipTarget(null);
      refetch();
    } catch (err) { message.error((err as Error).message); }
  };

  const handleBatchShip = async () => {
    try {
      const res = await orderApi.batchShip();
      const d = (res as { data?: { total?: number; shipped?: number; skipped?: number } }).data;
      message.success(`批量发货完成: ${d?.shipped ?? 0} 已发 / ${d?.total ?? 0} 总计`);
      refetch();
    } catch (err) { message.error((err as Error).message); }
  };

  return (
    <>
      <Card title="订单管理" extra={
        <Space>
          <Select placeholder="状态筛选" allowClear style={{ width: 160 }} value={status} onChange={(v) => { setStatus(v ?? ""); setPage(1); }}
            options={[
              { value: "awaiting_packaging", label: "待打包" }, { value: "awaiting_deliver", label: "待发货" },
              { value: "delivering", label: "运输中" }, { value: "delivered", label: "已签收" }, { value: "cancelled", label: "已取消" },
            ]} />
          <Button icon={<ReloadOutlined />} onClick={handleSync}>同步订单</Button>
          <Popconfirm title="确认批量发货？将对所有待发货订单执行自动发货" onConfirm={handleBatchShip}>
            <Button icon={<ThunderboltOutlined />} type="primary" ghost>批量发货</Button>
          </Popconfirm>
        </Space>
      }>
        <Table
          dataSource={orders}
          rowKey="id"
          loading={isLoading}
          size="small"
          pagination={{
            current: page,
            pageSize,
            total: orders.length >= 100 ? 200 : orders.length, // backend LIMIT 100
            showSizeChanger: true,
            pageSizeOptions: ["10", "20", "50", "100"],
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
            showTotal: (total) => `共 ${total} 条`,
          }}
          columns={[
            { title: "订单号", dataIndex: "posting_number", width: 140 },
            { title: "状态", dataIndex: "status", render: (s: string) => <Tag>{s}</Tag>, width: 120 },
            { title: "金额", dataIndex: "total_price_rub", render: (v: number) => `${v} ₽`, width: 100 },
            { title: "件数", dataIndex: "product_count", width: 60 },
            { title: "物流", dataIndex: "tracking_number", ellipsis: true, width: 160, render: (v: string) => v || "-" },
            {
              title: "商品", width: 120, render: (_: unknown, row: OrderRow) => {
                const products = parseProducts(row);
                if (products.length === 0) return <Tag>无数据</Tag>;
                return <Space size={2} wrap>{products.slice(0, 3).map((p, i) => <Tag key={i} color="blue">SKU:{p.sku}x{p.quantity}</Tag>)}{products.length > 3 && <Tag>+{products.length - 3}</Tag>}</Space>;
              },
            },
            {
              title: "操作", width: 100, render: (_: unknown, r: OrderRow) =>
                r.status === "awaiting_deliver"
                  ? <Button size="small" icon={<SendOutlined />} onClick={() => openShipModal(r)}>发货</Button>
                  : null
            },
          ]}
        />
      </Card>

      <Modal
        title={`发货 — ${shipTarget?.posting_number ?? ""}`}
        open={shipModalOpen}
        onOk={handleShip}
        onCancel={() => { setShipModalOpen(false); setShipTarget(null); }}
        okText="确认发货"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <div>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>物流单号</div>
            <Input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="输入物流单号" />
          </div>
          <div>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>发货产品</div>
            {shipProducts.map((p, i) => (
              <Space key={i} style={{ marginBottom: 8 }}>
                <span>SKU:</span>
                <InputNumber min={1} value={p.sku} disabled style={{ width: 120 }} />
                <span>数量:</span>
                <InputNumber
                  min={1}
                  value={p.quantity}
                  onChange={(v) => {
                    const updated = [...shipProducts];
                    updated[i] = { ...updated[i], quantity: v ?? 1 };
                    setShipProducts(updated);
                  }}
                  style={{ width: 80 }}
                />
              </Space>
            ))}
            {shipProducts.length === 0 && <Tag>无法解析产品信息</Tag>}
          </div>
        </Space>
      </Modal>
    </>
  );
}
