import { useMemo, useState } from "react";
import { Badge, Button, Card, DatePicker, Input, InputNumber, Modal, Popconfirm, Space, Statistic, Table, Tabs, Tag, message } from "antd";
import { AuditOutlined, ReloadOutlined, SendOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import dayjs from "dayjs";
import {
  orderApi, useOrders, normalizeReconcile,
  type OrderProduct, type OrderRow, type ReconcileView,
} from "../api/order-api";
import PageContainer from "../components/PageContainer";
import { hoursUntil } from "../utils/time";

// 状态机流水线 Tab（方案 §3.2b）：每个 Tab 是一个任务队列
const TAB_KEYS = ["awaiting_packaging", "awaiting_deliver", "delivering", "cancelled", "all"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_LABELS: Record<TabKey, string> = {
  awaiting_packaging: "待处理",
  awaiting_deliver: "待发货",
  delivering: "运输中",
  cancelled: "已取消",
  all: "全部",
};

const statusLabels: Record<string, string> = {
  awaiting_packaging: "待处理",
  awaiting_deliver: "待发货",
  delivering: "运输中",
  delivered: "已签收",
  cancelled: "已取消",
};

const statusColors: Record<string, string> = {
  awaiting_packaging: "orange",
  awaiting_deliver: "gold",
  delivering: "blue",
  delivered: "green",
  cancelled: "red",
};

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

/** 发货截止渲染：负数超时红 Tag / <12h 红色加粗 / <24h 橙色 / 其余默认色 */
function renderDeadline(deadline?: string | null) {
  const hours = hoursUntil(deadline);
  if (hours === null) return "—";
  if (hours < 0) return <Tag color="red">已超时 {Math.floor(-hours)}h</Tag>;
  if (hours < 12) return <span style={{ color: "#ef4444", fontWeight: 700 }}>剩 {Math.floor(hours)}h</span>;
  if (hours < 24) return <span style={{ color: "#f59e0b" }}>剩 {Math.floor(hours)}h</span>;
  return <span>剩 {Math.floor(hours)}h</span>;
}

export default function Orders() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") || "awaiting_packaging";
  const activeTab: TabKey = (TAB_KEYS as readonly string[]).includes(tabParam) ? (tabParam as TabKey) : "awaiting_packaging";

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [shipModalOpen, setShipModalOpen] = useState(false);
  const [shipTarget, setShipTarget] = useState<OrderRow | null>(null);
  const [trackingNumber, setTrackingNumber] = useState("");
  const [shipProducts, setShipProducts] = useState<OrderProduct[]>([]);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [reconcileRange, setReconcileRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs().subtract(6, "day"), dayjs()]);
  const [reconcileResult, setReconcileResult] = useState<ReconcileView | null>(null);

  // 全量（后端 LIMIT 100）一次拉取，Tab 角标计数与各 Tab 数据都由前端分组
  const ordersQuery = useOrders();
  const { data: ordersData, isLoading } = ordersQuery;

  const orders = ordersData || [];

  const counts = useMemo(() => {
    const c: Record<TabKey, number> = { awaiting_packaging: 0, awaiting_deliver: 0, delivering: 0, cancelled: 0, all: orders.length };
    for (const o of orders) {
      if (o.status in c && o.status !== "all") c[o.status as TabKey] += 1;
    }
    return c;
  }, [orders]);

  const tabOrders = useMemo(() => {
    const filtered = activeTab === "all" ? orders : orders.filter((o) => o.status === activeTab);
    // 待发货：按发货截止升序，最紧急在最上，无截止时间的排最后
    if (activeTab === "awaiting_deliver") {
      return [...filtered].sort((a, b) =>
        (hoursUntil(a.shipmentDeadline) ?? Number.MAX_SAFE_INTEGER) - (hoursUntil(b.shipmentDeadline) ?? Number.MAX_SAFE_INTEGER)
      );
    }
    return filtered;
  }, [orders, activeTab]);

  const invalidateOrders = () => qc.invalidateQueries({ queryKey: ["orders"] });

  const syncMutation = useMutation({
    mutationFn: () => orderApi.sync(),
    onSuccess: () => { message.success("同步已启动"); invalidateOrders(); },
    onError: (e: Error) => message.error(e.message),
  });

  const shipMutation = useMutation({
    mutationFn: (args: { postingNumber: string; trackingNumber: string; products: OrderProduct[] }) =>
      orderApi.ship(args.postingNumber, args.trackingNumber, args.products),
    onSuccess: () => {
      message.success("已标记发货");
      setShipModalOpen(false);
      setShipTarget(null);
      invalidateOrders();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const batchShipMutation = useMutation({
    mutationFn: () => orderApi.batchShip(),
    onSuccess: (d) => {
      message.success(`批量发货完成: ${d?.shipped ?? 0} 已发 / ${d?.total ?? 0} 总计`);
      invalidateOrders();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const reconcileMutation = useMutation({
    mutationFn: async () => {
      const [from, to] = reconcileRange;
      await orderApi.reconcile(from.format("YYYY-MM-DD"), to.format("YYYY-MM-DD"));
      return normalizeReconcile(await orderApi.reconcileLatest());
    },
    onSuccess: (view) => {
      if (!view) { message.info("对账已执行，但暂无可展示的结果"); return; }
      setReconcileResult(view);
      message.success("对账完成");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const latestReconcileMutation = useMutation({
    mutationFn: async () => normalizeReconcile(await orderApi.reconcileLatest()),
    onSuccess: (view) => {
      if (!view) { message.info("暂无对账记录"); return; }
      setReconcileResult(view);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const handleTabChange = (key: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", key);
    setSearchParams(params, { replace: true });
    setPage(1);
  };

  const openShipModal = (row: OrderRow) => {
    const products = parseProducts(row);
    setShipTarget(row);
    setShipProducts(products);
    setTrackingNumber(row.tracking_number || `ONZO-${Date.now().toString(36).toUpperCase()}`);
    setShipModalOpen(true);
  };

  const handleShip = () => {
    if (!shipTarget) return;
    if (!trackingNumber.trim()) { message.warning("请输入物流单号"); return; }
    shipMutation.mutate({ postingNumber: shipTarget.posting_number, trackingNumber: trackingNumber.trim(), products: shipProducts });
  };

  const baseColumns = [
    { title: "订单号", dataIndex: "posting_number", width: 140 },
    { title: "状态", dataIndex: "status", width: 100, render: (s: string) => <Tag color={statusColors[s]}>{statusLabels[s] || s}</Tag> },
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
  ];

  // 待发货 Tab 在「状态」后插入「发货截止」列
  const columns = activeTab === "awaiting_deliver"
    ? [...baseColumns.slice(0, 2), { title: "发货截止", dataIndex: "shipmentDeadline", width: 110, render: (v: string | null) => renderDeadline(v) }, ...baseColumns.slice(2)]
    : baseColumns;

  return (
    <PageContainer
      title="订单管理"
      subTitle="按状态流水线处理：清空每个 Tab 即完成当日发货工作"
      updatedAt={ordersQuery.dataUpdatedAt}
      extra={
        <Space>
          <Button icon={<AuditOutlined />} onClick={() => setReconcileOpen(true)}>对账</Button>
          <Button icon={<ReloadOutlined />} loading={syncMutation.isPending} onClick={() => syncMutation.mutate()}>同步订单</Button>
          <Popconfirm title="确认批量发货？将对所有待发货订单执行自动发货" onConfirm={() => batchShipMutation.mutate()}>
            <Button icon={<ThunderboltOutlined />} type="primary" ghost loading={batchShipMutation.isPending}>批量发货</Button>
          </Popconfirm>
        </Space>
      }
    >
      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={handleTabChange}
          items={TAB_KEYS.map((k) => ({
            key: k,
            label: <Badge count={counts[k]} size="small" offset={[8, -2]}>{TAB_LABELS[k]}</Badge>,
          }))}
        />
        <Table
          dataSource={tabOrders}
          rowKey="id"
          loading={isLoading}
          size="small"
          scroll={{ x: "max-content" }}
          pagination={{
            current: page,
            pageSize,
            total: tabOrders.length, // backend fixed LIMIT 100, no pagination params
            showSizeChanger: true,
            pageSizeOptions: ["10", "20", "50", "100"],
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
            showTotal: (total) => `共 ${total} 条`,
          }}
          columns={columns}
        />
        {orders.length >= 100 && (
          <div style={{ marginTop: 8, color: "#888", fontSize: 12 }}>仅显示最近 100 条，更多请用筛选条件</div>
        )}
      </Card>

      <Modal
        title={`发货 — ${shipTarget?.posting_number ?? ""}`}
        open={shipModalOpen}
        onOk={handleShip}
        onCancel={() => { setShipModalOpen(false); setShipTarget(null); }}
        okText="确认发货"
        cancelText="取消"
        confirmLoading={shipMutation.isPending}
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

      <Modal
        title="订单对账"
        open={reconcileOpen}
        onCancel={() => setReconcileOpen(false)}
        footer={null}
        width={760}
      >
        <Space wrap style={{ marginBottom: 8 }}>
          <DatePicker.RangePicker
            value={reconcileRange}
            onChange={(v) => { if (v?.[0] && v?.[1]) setReconcileRange([v[0], v[1]]); }}
            allowClear={false}
          />
          <Button type="primary" loading={reconcileMutation.isPending} onClick={() => reconcileMutation.mutate()}>
            开始对账
          </Button>
          <Button type="link" loading={latestReconcileMutation.isPending} onClick={() => latestReconcileMutation.mutate()}>
            查看最近对账结果
          </Button>
        </Space>

        {reconcileResult && (
          <div style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 12, color: "#888", fontSize: 12 }}>
              对账区间：{reconcileResult.dateFrom} ~ {reconcileResult.dateTo}
              {reconcileResult.createdAt && ` ｜ 执行于 ${reconcileResult.createdAt}`}
            </div>
            <Space size="large" wrap>
              <Statistic title="订单总数" value={reconcileResult.totalOrders} />
              <Statistic title="一致" value={reconcileResult.matched} valueStyle={{ color: "#10b981" }} />
              <Statistic
                title="差异"
                value={reconcileResult.discrepancies.length}
                valueStyle={reconcileResult.discrepancies.length > 0 ? { color: "#ef4444" } : undefined}
              />
              <Statistic title="本地缺失" value={reconcileResult.missingLocal} />
              <Statistic title="Ozon 缺失" value={reconcileResult.missingOzon} />
            </Space>
            {reconcileResult.totalOrders === 0 && (
              <div style={{ marginTop: 12, color: "#888", fontSize: 12 }}>
                该区间 Ozon 无结算报告或本地无已完成订单，无对账数据
              </div>
            )}
            {reconcileResult.discrepancies.length > 0 && (
              <Table
                style={{ marginTop: 12 }}
                dataSource={reconcileResult.discrepancies}
                rowKey="orderId"
                size="small"
                scroll={{ x: "max-content" }}
                pagination={{ pageSize: 10 }}
                columns={[
                  { title: "订单号", dataIndex: "orderId", width: 120 },
                  { title: "本地结算", dataIndex: "localPayout", render: (v: number) => `${v} ₽` },
                  { title: "Ozon 结算", dataIndex: "ozonPayout", render: (v: number) => `${v} ₽` },
                  { title: "差额", dataIndex: "difference", render: (v: number) => <span style={{ color: "#ef4444" }}>{v} ₽</span> },
                  { title: "原因", dataIndex: "reason", render: (v: string) => v || "-" },
                ]}
              />
            )}
          </div>
        )}
      </Modal>
    </PageContainer>
  );
}
