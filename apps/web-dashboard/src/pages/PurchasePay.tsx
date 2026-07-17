import { useState } from "react";
import { Row, Col, Card, Statistic, Table, Tag, Button, Space, Spin, Modal, InputNumber, message } from "antd";
import { ReloadOutlined, DollarOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { usePurchaseList, usePurchaseBill, usePayMutation, useRetryMutation } from "../api/purchase-api";

export default function PurchasePay() {
  const { data: listData, isLoading } = usePurchaseList();
  const { data: billData } = usePurchaseBill();
  const payMutation = usePayMutation();
  const retryMutation = useRetryMutation();
  const [modalOpen, setModalOpen] = useState(false);
  const [payForm, setPayForm] = useState({ postingNumber: "", costCny: 0, sellingPriceRub: 0, ozonOrderId: 0 });

  if (isLoading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;

  const items = (listData as unknown as { data?: Array<Record<string, unknown>> })?.data || [];
  const bill = billData as unknown as { data?: { totalCny?: number; count?: number } } || {};
  const pending = items.filter((i) => i.payment_status === "pending").length;
  const failed = items.filter((i) => i.payment_status === "failed").length;
  const paid = items.filter((i) => i.payment_status === "paid").length;

  const statusColor: Record<string, string> = {
    pending: "default", paying: "processing", paid: "green", failed: "red",
  };

  const columns = [
    { title: "Ozon单号", dataIndex: "ozon_posting_number", key: "posting", width: 160 },
    { title: "金额(¥)", dataIndex: "total_amount_cny", key: "amount", width: 100, render: (v: number) => `¥${v?.toFixed(2) || "0.00"}` },
    { title: "状态", dataIndex: "payment_status", key: "status", width: 90, render: (s: string) => <Tag color={statusColor[s] || "default"}>{s}</Tag> },
    { title: "渠道", dataIndex: "pay_channel", key: "channel", width: 120 },
    { title: "支付时间", dataIndex: "pay_time", key: "time", width: 170 },
    {
      title: "操作", key: "action", width: 100,
      render: (_: unknown, r: Record<string, unknown>) =>
        r.payment_status === "failed" ? (
          <Button size="small" type="primary" danger icon={<ReloadOutlined />}
            loading={retryMutation.isPending}
            onClick={() => {
              retryMutation.mutate(r.id as string, {
                onSuccess: () => message.success("重试已提交"),
                onError: (e: Error) => message.error(e.message),
              });
            }}>
            重试
          </Button>
        ) : null,
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