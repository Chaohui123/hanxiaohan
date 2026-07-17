import { useQuery } from "@tanstack/react-query";
import { Row, Col, Card, Statistic, Table, Tag, Spin, Progress } from "antd";
import { CloudOutlined, GlobalOutlined } from "@ant-design/icons";
import { dashboardApi, taskApi, monitorApi, inventoryApi } from "../api/client";
import AlertBanner from "../components/AlertBanner";

export default function Dashboard() {
  const { data: dash, isLoading } = useQuery({ queryKey: ["dashboard"], queryFn: () => dashboardApi.stats(), refetchInterval: 15_000 });
  const { data: global } = useQuery({ queryKey: ["global"], queryFn: () => dashboardApi.globalStats(), refetchInterval: 30_000 });
  const { data: cos } = useQuery({ queryKey: ["cos"], queryFn: () => dashboardApi.cosStats(), refetchInterval: 60_000 });
  const { data: queue } = useQuery({ queryKey: ["queue"], queryFn: () => taskApi.queueStats(), refetchInterval: 15_000 });
  const { data: llm } = useQuery({ queryKey: ["llm"], queryFn: () => monitorApi.llmStats(), refetchInterval: 30_000 });
  const { data: listings } = useQuery({ queryKey: ["listings"], queryFn: () => taskApi.listings() });
  const { data: failed } = useQuery({ queryKey: ["failed"], queryFn: () => taskApi.failed() });

  if (isLoading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;

  const d = (dash as { data?: Record<string, unknown> })?.data || {};
  const g = (global as { data?: Record<string, unknown> })?.data || {};
  const c = (cos as { data?: Record<string, number> })?.data || {};
  const q = (queue as { data?: Record<string, unknown> })?.data || {};
  const l = (llm as { data?: Record<string, number> })?.data || {};

  return (
    <div>
      <AlertBanner />

      {/* Multi-store Global Summary */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={16}>
          <Col xs={12} sm={4}><Statistic title="店铺数" value={Number(g.stores) || 1} prefix={<GlobalOutlined />} /></Col>
          <Col xs={12} sm={4}><Statistic title="总上架" value={Number(g.totalListings) || 0} /></Col>
          <Col xs={12} sm={4}><Statistic title="总订单" value={Number(g.totalOrders) || 0} /></Col>
          <Col xs={12} sm={4}><Statistic title="总库存" value={Number(g.totalInventory) || 0} /></Col>
          <Col xs={12} sm={4}><Statistic title="Token总量" value={(Number(g.totalTokens) || 0).toLocaleString()} /></Col>
          <Col xs={12} sm={4}>
            <Statistic title="COS存储" value={`${c.usagePercent || 0}%`}
              valueStyle={{ color: (c.usagePercent || 0) > 80 ? "#ef4444" : (c.usagePercent || 0) > 50 ? "#f59e0b" : "#10b981" }} />
            <Progress percent={c.usagePercent || 0} size="small" status={(c.usagePercent || 0) > 80 ? "exception" : "normal"}
              format={() => `${c.totalImages || 0}张`} />
          </Col>
        </Row>
      </Card>

      {/* Today's metrics */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={4}><Card><Statistic title="今日上架" value={Number(d.todayListings) || 0} valueStyle={{ color: "#10b981" }} /></Card></Col>
        <Col xs={12} sm={8} md={4}><Card><Statistic title="队列中" value={Number(q.queued) || 0} valueStyle={{ color: "#f59e0b" }} /></Card></Col>
        <Col xs={12} sm={8} md={4}><Card><Statistic title="处理中" value={Number(q.processing) || 0} valueStyle={{ color: "#3b82f6" }} /></Card></Col>
        <Col xs={12} sm={8} md={4}><Card><Statistic title="失败" value={Number(q.failed) || 0} valueStyle={{ color: Number(q.failed) > 0 ? "#ef4444" : "#10b981" }} /></Card></Col>
        <Col xs={12} sm={8} md={4}><Card><Statistic title="低库存" value={Number(d.lowStockProducts) || 0} valueStyle={{ color: Number(d.lowStockProducts) > 0 ? "#ef4444" : "#10b981" }} /></Card></Col>
        <Col xs={12} sm={8} md={4}><Card><Statistic title="今日Token" value={(Number(l.todayTokens) || Number(d.todayTokens) || 0).toLocaleString()} suffix={`/ ${(Number(l.dailyLimit) || 500000).toLocaleString()}`} /></Card></Col>
      </Row>

      {/* COS Storage card */}
      {Number(c.deadLetter) > 0 && (
        <Card size="small" style={{ marginTop: 16, borderColor: "#ef4444" }}>
          <span><CloudOutlined /> COS死信图片: {c.deadLetter} 张 — 建议清理释放空间</span>
        </Card>
      )}

      {/* Recent listings + Failed tasks */}
      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="最近上架" size="small">
            <Table dataSource={(Array.isArray((listings as { data?: unknown[] })?.data) ? (listings as { data: unknown[] }).data : []).slice(0, 5)}
              rowKey="id" size="small" pagination={false} scroll={{ x: 400 }}
              columns={[
                { title: "URL", dataIndex: "sourceUrl", ellipsis: true, width: 200 },
                { title: "状态", dataIndex: "status", render: (s: string) => <Tag color={s === "done" ? "green" : "red"}>{s}</Tag> },
                { title: "时间", dataIndex: "createdAt", width: 160 },
              ]} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="失败任务" size="small" style={{ borderColor: (Array.isArray((failed as { data?: unknown[] })?.data) ? (failed as { data: unknown[] }).data : []).length > 0 ? "#ef4444" : undefined }}>
            <Table dataSource={(Array.isArray((failed as { data?: unknown[] })?.data) ? (failed as { data: unknown[] }).data : []).slice(0, 5)}
              rowKey="id" size="small" pagination={false} scroll={{ x: 400 }}
              columns={[
                { title: "类型", dataIndex: "taskType", width: 100 },
                { title: "错误", dataIndex: "errorMessage", ellipsis: true },
              ]}
              locale={{ emptyText: "✅ 无失败任务" }} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}