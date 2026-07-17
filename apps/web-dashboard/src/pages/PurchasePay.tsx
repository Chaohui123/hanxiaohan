import { useState } from "react";
import { Row, Col, Card, Statistic, Table, Tag, Button, Space, Spin, Modal, Input, InputNumber, Select, message, Tooltip } from "antd";
import { ReloadOutlined, DollarOutlined, ThunderboltOutlined, EditOutlined, CopyOutlined, EyeOutlined } from "@ant-design/icons";
import { usePurchaseList, usePurchaseBill, usePayMutation, useRetryMutation, useUpdateMutation } from "../api/purchase-api";

// ---- 中文状态映射 ----
const STATUS_MAP: Record<string, { label: string; color: string }> = {
  pending_payment:  { label: "待付款",   color: "orange" },
  pending:          { label: "待处理",   color: "orange" },
  paying:           { label: "支付中",   color: "processing" },
  paid:             { label: "已支付",   color: "green" },
  failed:           { label: "支付失败", color: "red" },
  cancelled:        { label: "已取消",   color: "default" },
  idle:             { label: "未发货",   color: "default" },
  shipped:          { label: "已发货",   color: "blue" },
  delivered:        { label: "已签收",   color: "green" },
};

const CHANNEL_MAP: Record<string, string> = {
  manual_pay:    "人工付款",
  alipay_deduct: "支付宝代扣",
  chengyishe:    "诚E赊",
  kuajingbao:    "跨境宝",
};

function statusLabel(s: string) {
  const m = STATUS_MAP[s] || { label: s, color: "default" };
  return <Tag color={m.color}>{m.label}</Tag>;
}

function channelLabel(c: string) {
  return CHANNEL_MAP[c] || c || "—";
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(() => message.success("已复制")).catch(() => message.error("复制失败"));
}

export default function PurchasePay() {
  const { data: listData, isLoading } = usePurchaseList();
  const { data: billData } = usePurchaseBill();
  const payMutation = usePayMutation();
  const retryMutation = useRetryMutation();
  const updateMutation = useUpdateMutation();
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModal, setDetailModal] = useState<Record<string, unknown> | null>(null);
  const [editModal, setEditModal] = useState<Record<string, unknown> | null>(null);
  const [payForm, setPayForm] = useState({ postingNumber: "", costCny: 0, sellingPriceRub: 0, ozonOrderId: 0 });
  const [editForm, setEditForm] = useState({ paymentStatus: "", paySerial: "", logisticsStatus: "", logisticsTracking: "", logisticsCarrier: "" });

  if (isLoading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;

  const items = (listData as unknown as { data?: Array<Record<string, unknown>> })?.data || [];
  const bill = billData as unknown as { data?: { totalCny?: number; count?: number } } || {};
  const pending = items.filter((i) => i.payment_status === "pending_payment" || i.payment_status === "pending").length;
  const failed = items.filter((i) => i.payment_status === "failed").length;
  const paid = items.filter((i) => i.payment_status === "paid").length;

  const columns = [
    { title: "Ozon单号", dataIndex: "ozon_posting_number", key: "posting", width: 160 },
    {
      title: "金额(¥)", dataIndex: "total_amount_cny", key: "amount", width: 100,
      render: (v: number) => <strong>¥{v?.toFixed(2) || "0.00"}</strong>,
    },
    { title: "状态", dataIndex: "payment_status", key: "status", width: 90, render: (s: string) => statusLabel(s) },
    { title: "渠道", dataIndex: "pay_channel", key: "channel", width: 100, render: (c: string) => channelLabel(c) },
    {
      title: "物流", dataIndex: "logistics_status", key: "logistics", width: 80, render: (s: string) => statusLabel(s),
    },
    { title: "支付时间", dataIndex: "pay_time", key: "time", width: 150, render: (v: string) => v || "—" },
    {
      title: "操作", key: "action", width: 200,
      render: (_: unknown, r: Record<string, unknown>) => {
        const st = (r.payment_status as string) || "";
        const freight = (r.freight_address as string) || "";
        const url = (r.source_1688_url as string) || "";
        return (
          <Space size="small">
            <Tooltip title="查看详情">
              <Button size="small" icon={<EyeOutlined />} onClick={() => setDetailModal(r)} />
            </Tooltip>
            {freight && (
              <Tooltip title="复制收货地址">
                <Button size="small" icon={<CopyOutlined />} onClick={() => copyToClipboard(freight)} />
              </Tooltip>
            )}
            {url && (
              <Tooltip title="打开1688链接">
                <Button size="small" onClick={() => window.open(url, "_blank")}>1688</Button>
              </Tooltip>
            )}
            {st === "failed" && (
              <Button size="small" type="primary" danger icon={<ReloadOutlined />}
                loading={retryMutation.isPending}
                onClick={() => retryMutation.mutate(r.id as string, {
                  onSuccess: () => message.success("重试已提交"),
                  onError: (e: Error) => message.error(e.message),
                })}>
                重试
              </Button>
            )}
            <Button size="small" icon={<EditOutlined />}
              onClick={() => {
                setEditForm({
                  paymentStatus: (r.payment_status as string) || "",
                  paySerial: (r.pay_serial as string) || "",
                  logisticsStatus: (r.logistics_status as string) || "",
                  logisticsTracking: (r.logistics_tracking as string) || "",
                  logisticsCarrier: (r.logistics_carrier as string) || "",
                });
                setEditModal(r);
              }}>
              编辑
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}><Card><Statistic title="待支付" value={pending} valueStyle={{ color: "#f59e0b" }} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="支付中" value={items.filter((i) => i.payment_status === "paying").length} valueStyle={{ color: "#3b82f6" }} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="已支付" value={paid} valueStyle={{ color: "#10b981" }} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="失败" value={failed} valueStyle={{ color: failed > 0 ? "#ef4444" : "#10b981" }} /></Card></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={12} sm={6}><Card><Statistic title="今日支出" value={bill?.data?.totalCny || 0} prefix="¥" /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="今日笔数" value={bill?.data?.count || 0} /></Card></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card
            title="采购支付列表"
            extra={
              <Space>
                <Button icon={<ThunderboltOutlined />} onClick={() => setModalOpen(true)}>手动支付</Button>
                <Button icon={<ReloadOutlined />} onClick={() => message.info("刷新中...")}>刷新</Button>
              </Space>
            }
          >
            <Table dataSource={items.map((item, i) => ({ ...item, key: i }))} columns={columns} pagination={{ pageSize: 20 }} size="small" scroll={{ y: 500 }} />
          </Card>
        </Col>
      </Row>

      <Modal title="采购详情" open={!!detailModal} onCancel={() => setDetailModal(null)} footer={null} width={600}>
        {detailModal && (
          <div style={{ lineHeight: 2 }}>
            <p><strong>采购编号：</strong>{detailModal.id as string}</p>
            <p><strong>Ozon 单号：</strong>{detailModal.ozon_posting_number as string}</p>
            <p><strong>1688 链接：</strong><a href={detailModal.source_1688_url as string} target="_blank" rel="noreferrer">{detailModal.source_1688_url as string}</a></p>
            <p><strong>金额：</strong>¥{(detailModal.total_amount_cny as number)?.toFixed(2)}</p>
            <p><strong>状态：</strong>{statusLabel(detailModal.payment_status as string)}</p>
            <p><strong>渠道：</strong>{channelLabel(detailModal.pay_channel as string)}</p>
            <p><strong>收货地址：</strong>{detailModal.freight_address as string || "未设置"}</p>
            <p><strong>物流编号：</strong>{detailModal.logistics_tracking as string || "—"}</p>
            <p><strong>创建时间：</strong>{detailModal.created_at as string}</p>
          </div>
        )}
      </Modal>

      <Modal title="编辑采购单" open={!!editModal} onCancel={() => setEditModal(null)}
        onOk={() => {
          if (!editModal?.id) return;
          updateMutation.mutate(
            { id: editModal.id as string, ...editForm },
            { onSuccess: () => { message.success("已更新"); setEditModal(null); }, onError: (e: Error) => message.error(e.message) }
          );
        }}
        confirmLoading={updateMutation.isPending}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <span>付款状态：</span>
          <Select style={{ width: "100%" }} value={editForm.paymentStatus}
            onChange={(v) => setEditForm({ ...editForm, paymentStatus: v })}>
            <Select.Option value="">不变更</Select.Option>
            <Select.Option value="pending_payment">待付款</Select.Option>
            <Select.Option value="paying">支付中</Select.Option>
            <Select.Option value="paid">已支付</Select.Option>
            <Select.Option value="failed">支付失败</Select.Option>
            <Select.Option value="cancelled">已取消</Select.Option>
          </Select>
          <span>支付流水号：</span>
          <Input value={editForm.paySerial} onChange={(e) => setEditForm({ ...editForm, paySerial: e.target.value })} placeholder="1688支付流水号" />
          <span>物流状态：</span>
          <Select style={{ width: "100%" }} value={editForm.logisticsStatus}
            onChange={(v) => setEditForm({ ...editForm, logisticsStatus: v })}>
            <Select.Option value="">不变更</Select.Option>
            <Select.Option value="idle">未发货</Select.Option>
            <Select.Option value="shipped">已发货</Select.Option>
            <Select.Option value="delivered">已签收</Select.Option>
          </Select>
          <span>物流单号：</span>
          <Input value={editForm.logisticsTracking} onChange={(e) => setEditForm({ ...editForm, logisticsTracking: e.target.value })} placeholder="快递单号" />
          <span>物流公司：</span>
          <Input value={editForm.logisticsCarrier} onChange={(e) => setEditForm({ ...editForm, logisticsCarrier: e.target.value })} placeholder="如：中通、圆通" />
        </Space>
      </Modal>

      <Modal title="手动发起支付" open={modalOpen} onCancel={() => setModalOpen(false)}
        onOk={() => {
          payMutation.mutate({ ...payForm, skuList: [{ sku: 0, quantity: 1, unitPriceCny: payForm.costCny }] }, {
            onSuccess: () => { message.success("支付已提交"); setModalOpen(false); },
            onError: (e: Error) => message.error(e.message),
          });
        }}
        confirmLoading={payMutation.isPending}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <span>Ozon Posting Number:</span>
          <InputNumber style={{ width: "100%" }} placeholder="Posting Number" value={payForm.postingNumber as unknown as number}
            onChange={(v) => setPayForm({ ...payForm, postingNumber: String(v || "") })} />
          <span>采购金额 (¥):</span>
          <InputNumber style={{ width: "100%" }} min={0} value={payForm.costCny}
            onChange={(v) => setPayForm({ ...payForm, costCny: v || 0 })} prefix="¥" />
          <span>Ozon售价 (₽):</span>
          <InputNumber style={{ width: "100%" }} min={0} value={payForm.sellingPriceRub}
            onChange={(v) => setPayForm({ ...payForm, sellingPriceRub: v || 0 })} prefix="₽" />
          <span>Ozon Order ID:</span>
          <InputNumber style={{ width: "100%" }} min={0} value={payForm.ozonOrderId}
            onChange={(v) => setPayForm({ ...payForm, ozonOrderId: v || 0 })} />
        </Space>
      </Modal>
    </div>
  );
}