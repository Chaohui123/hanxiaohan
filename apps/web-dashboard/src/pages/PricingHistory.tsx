import { useMemo, useState } from "react";
import { Card, Table, Input, Row, Col, Statistic, Spin, Tag } from "antd";
import { usePricingHistory } from "../api/promo-api";

export default function PricingHistory() {
  const [searchText, setSearchText] = useState("");
  const { data, isLoading } = usePricingHistory(30);
  const adjustments = (data as { adjustments?: Array<Record<string, unknown>> })?.adjustments || [];

  const filtered = useMemo(() => {
    if (!searchText) return adjustments;
    return adjustments.filter((a) =>
      String(a.name || "").toLowerCase().includes(searchText.toLowerCase()) ||
      String(a.offerId || "").toLowerCase().includes(searchText.toLowerCase())
    );
  }, [adjustments, searchText]);

  const stats = useMemo(() => {
    const total = filtered.length;
    let totalIncrease = 0;
    let positiveCount = 0;
    for (const a of filtered) {
      const inc = Number(a.salesAfter || 0) - Number(a.salesBefore || 0);
      totalIncrease += inc;
      if (inc > 0) positiveCount++;
    }
    return { total, avgIncrease: total > 0 ? (totalIncrease / total).toFixed(1) : "0", positiveRate: total > 0 ? ((positiveCount / total) * 100).toFixed(0) : "0" };
  }, [filtered]);

  const columns = [
    { title: "商品", dataIndex: "name", key: "name", width: 160, ellipsis: true },
    { title: "OfferID", dataIndex: "offerId", key: "offerId", width: 110 },
    { title: "原价", dataIndex: "oldPrice", key: "oldPrice", width: 90, render: (v: number) => `${v?.toFixed(0) || 0} ₽` },
    { title: "新价", dataIndex: "newPrice", key: "newPrice", width: 90, render: (v: number) => `${v?.toFixed(0) || 0} ₽` },
    { title: "原因", dataIndex: "reason", key: "reason", width: 150, ellipsis: true },
    { title: "调前7天", dataIndex: "salesBefore", key: "salesBefore", width: 80 },
    { title: "调后7天", dataIndex: "salesAfter", key: "salesAfter", width: 80 },
    {
      title: "增量", key: "delta", width: 70,
      render: (_: unknown, r: Record<string, unknown>) => {
        const d = Number(r.salesAfter || 0) - Number(r.salesBefore || 0);
        return <Tag color={d > 0 ? "green" : d < 0 ? "red" : "default"}>{d > 0 ? "+" : ""}{d}</Tag>;
      },
    },
    { title: "时间", dataIndex: "appliedAt", key: "appliedAt", width: 130, render: (v: string) => String(v || "").slice(0, 19).replace("T", " ") },
  ];

  if (isLoading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col xs={8}><Card><Statistic title="总调价" value={stats.total} suffix="次" /></Card></Col>
        <Col xs={8}><Card><Statistic title="平均增量" value={stats.avgIncrease} suffix="单" valueStyle={{ color: Number(stats.avgIncrease) > 0 ? "#10b981" : "#ef4444" }} /></Card></Col>
        <Col xs={8}><Card><Statistic title="正向占比" value={stats.positiveRate} suffix="%" valueStyle={{ color: Number(stats.positiveRate) >= 50 ? "#10b981" : "#f59e0b" }} /></Card></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card title="调价历史" extra={<Input.Search placeholder="搜索商品名/OfferID" onChange={(e) => setSearchText(e.target.value)} style={{ width: 260 }} />}>
            <Table dataSource={filtered.map((item, i) => ({ ...item, key: i }))} columns={columns} pagination={{ pageSize: 20 }} size="small" scroll={{ x: 1000 }} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
