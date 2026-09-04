import { useState } from "react";
import { Card, Table, Tag, Button, Input, Space, Modal, message, Row, Col } from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useWatchList, useCompetitorPrices, usePromoEvents, useAddWatch, useRemoveWatch } from "../api/promo-api";
import PageContainer from "../components/PageContainer";
import QueryState from "../components/QueryState";
import { useChartTheme } from "../components/ThemedChart";

export default function Competitor() {
  const watchQuery = useWatchList();
  const eventsQuery = usePromoEvents("price_drop_alert");
  const addWatch = useAddWatch();
  const removeWatch = useRemoveWatch();
  const [modalOpen, setModalOpen] = useState(false);
  const [newOfferId, setNewOfferId] = useState("");
  const [newName, setNewName] = useState("");
  const [selectedOfferId, setSelectedOfferId] = useState("");
  const { data: prices } = useCompetitorPrices(selectedOfferId, 30);
  const chartTheme = useChartTheme();

  const chartData = (prices || []).map((p) => ({
    date: String(p.capturedAt || "").slice(0, 10),
    price: Number(p.price || 0),
  }));

  const columns = [
    { title: "商品名", dataIndex: "name", key: "name", width: 200, ellipsis: true },
    { title: "OfferID", dataIndex: "offerId", key: "offerId", width: 120 },
    { title: "状态", dataIndex: "offerId", key: "status", width: 80, render: () => <Tag color="green">监控中</Tag> },
    {
      title: "操作", key: "action", width: 200, render: (_: unknown, record: { offerId?: string }) => (
        <Space>
          <Button size="small" onClick={() => setSelectedOfferId(selectedOfferId === record.offerId ? "" : String(record.offerId || ""))}>
            {selectedOfferId === record.offerId ? "隐藏趋势" : "价格趋势"}
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />}
            onClick={() => removeWatch.mutate(String(record.offerId || ""), { onSuccess: () => message.success("已移除") })}>
            移除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <PageContainer title="竞品监控" subTitle="监控竞品价格变动与降价告警" updatedAt={watchQuery.dataUpdatedAt}>
      <Row gutter={[16, 16]}>
        <Col xs={24}>
          <Card title="竞品监控列表" extra={
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>添加监控</Button>
          }>
            <QueryState query={watchQuery} emptyText="还没有监控竞品，点击右上角「添加监控」开始">
              {(watchList) => (
                <Table dataSource={watchList.map((item, i) => ({ ...item, key: i }))} columns={columns} pagination={false} size="small" scroll={{ x: "max-content" }} />
              )}
            </QueryState>
          </Card>
        </Col>
      </Row>

      {selectedOfferId && chartData.length > 0 && (
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24}>
            <Card title={`价格趋势 — ${selectedOfferId}`}>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} />
                  <XAxis dataKey="date" tick={{ fill: chartTheme.tickFill }} />
                  <YAxis tick={{ fill: chartTheme.tickFill }} />
                  <Tooltip contentStyle={chartTheme.tooltipStyle} />
                  <Line type="monotone" dataKey="price" stroke="#3b82f6" name="竞品均价" />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </Col>
        </Row>
      )}

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24}>
          <Card title="降价告警">
            <QueryState query={eventsQuery} emptyText="暂无降价告警">
              {(eventList) => (
                <Table
                  dataSource={eventList.slice(0, 20).map((e, i) => ({
                    key: i,
                    offerId: String(e.payload?.offerId || ""),
                    drop: String(e.payload?.dropPercent || ""),
                    time: String(e.createdAt || ""),
                  }))}
                  columns={[
                    { title: "商品", dataIndex: "offerId", key: "offerId" },
                    { title: "降幅", dataIndex: "drop", key: "drop", render: (v: string) => <Tag color="red">{v}%</Tag> },
                    { title: "时间", dataIndex: "time", key: "time" },
                  ]}
                  pagination={false} size="small" scroll={{ x: "max-content" }}
                />
              )}
            </QueryState>
          </Card>
        </Col>
      </Row>

      <Modal title="添加竞品监控" open={modalOpen} onOk={() => {
        addWatch.mutate({ offerId: newOfferId, name: newName }, { onSuccess: () => { setModalOpen(false); setNewOfferId(""); setNewName(""); message.success("已添加"); } });
      }} onCancel={() => setModalOpen(false)}>
        <Input placeholder="Offer ID" value={newOfferId} onChange={(e) => setNewOfferId(e.target.value)} style={{ marginBottom: 8 }} />
        <Input placeholder="商品名" value={newName} onChange={(e) => setNewName(e.target.value)} />
      </Modal>
    </PageContainer>
  );
}
