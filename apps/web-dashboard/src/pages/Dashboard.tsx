import { useQuery } from "@tanstack/react-query";
import { Row, Col, Card, Statistic, Table, Tag, Spin } from "antd";
import { dashboardApi, taskApi, monitorApi } from "../api/client";

export default function Dashboard() {
  const { data: dash, isLoading } = useQuery({ queryKey: ["dashboard"], queryFn: () => dashboardApi.stats(), refetchInterval: 15_000 });
  const { data: queue } = useQuery({ queryKey: ["queue"], queryFn: () => taskApi.queueStats(), refetchInterval: 15_000 });
  const { data: llm } = useQuery({ queryKey: ["llm"], queryFn: () => monitorApi.llmStats(), refetchInterval: 30_000 });
  const { data: listings } = useQuery({ queryKey: ["listings"], queryFn: () => taskApi.listings() });
  const { data: failed } = useQuery({ queryKey: ["failed"], queryFn: () => taskApi.failed() });

  if (isLoading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;

  const d = (dash as { data?: Record<string, unknown> })?.data || {};
  const q = (queue as { data?: Record<string, unknown> })?.data || {};
  const l = (llm as { data?: Record<string, number> })?.data || {};

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card><Statistic title="今日上架" value={Number(d.todayListings) || 0} valueStyle={{ color: "#10b981" }} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card><Statistic title="队列中" value={Number(q.queued) || 0} valueStyle={{ color: "#f59e0b" }} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card><Statistic title="处理中" value={Number(q.processing) || 0} valueStyle={{ color: "#3b82f6" }} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card><Statistic title="失败" value={Number(q.failed) || 0} valueStyle={{ color: Number(q.failed) > 0 ? "#ef4444" : "#10b981" }} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card><Statistic title="待处理订单" value={Number(d.pendingOrders) || 0} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card><Statistic title="今日Token" value={(Number(l.todayTokens) || 0).toLocaleString()} suffix={`/ ${(Number(l.dailyLimit) || 500000).toLocaleString()}`} /></Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card title="最近上架记录" size="small">
            <Table
              dataSource={(Array.isArray((listings as { data?: unknown[] })?.data) ? (listings as { data: unknown[] }).data : []).slice(0, 5)}
              rowKey="id"
              size="small"
              pagination={false}
              columns={[
                { title: "URL", dataIndex: "sourceUrl", ellipsis: true, width: 200 },
                { title: "状态", dataIndex: "status", render: (s: string) => <Tag color={s === "done" ? "green" : "red"}>{s}</Tag> },
                { title: "时间", dataIndex: "createdAt", width: 160 },
              ]}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="失败任务" size="small" style={{ borderColor: (Array.isArray((failed as { data?: unknown[] })?.data) ? (failed as { data: unknown[] }).data : []).length > 0 ? "#ef4444" : undefined }}>
            <Table
              dataSource={(Array.isArray((failed as { data?: unknown[] })?.data) ? (failed as { data: unknown[] }).data : []).slice(0, 5)}
              rowKey="id"
              size="small"
              pagination={false}
              columns={[
                { title: "类型", dataIndex: "taskType", width: 100 },
                { title: "错误", dataIndex: "errorMessage", ellipsis: true },
              ]}
              locale={{ emptyText: "✅ 无失败任务" }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
