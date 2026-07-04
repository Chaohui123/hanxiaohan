import { Card, Row, Col, Statistic, Table, Tag, Progress } from "antd";
import { monitorApi, taskApi } from "../api/client";
import { useQuery } from "@tanstack/react-query";

export default function Monitoring() {
  const { data: llm } = useQuery({ queryKey: ["mon-llm"], queryFn: () => monitorApi.llmStats(), refetchInterval: 30_000 });
  const { data: fx } = useQuery({ queryKey: ["fx"], queryFn: () => monitorApi.fxRate(), refetchInterval: 60_000 });
  const { data: scraper } = useQuery({ queryKey: ["scraper-m"], queryFn: () => monitorApi.scraperMetrics(), refetchInterval: 30_000 });
  const { data: dead } = useQuery({ queryKey: ["dead-letter"], queryFn: () => taskApi.failed(), refetchInterval: 30_000 });
  const { data: pipeline } = useQuery({ queryKey: ["pipeline-h"], queryFn: () => monitorApi.pipelineHealth(), refetchInterval: 60_000 });

  const l = (llm as { data?: Record<string, number> })?.data || {};
  const f = (fx as { data?: Record<string, unknown> })?.data || {};
  const s = (scraper as { data?: Record<string, unknown> })?.data || {};
  const deadList = (Array.isArray((dead as { data?: unknown[] })?.data) ? (dead as { data: unknown[] }).data : []);
  const components = (pipeline as { components?: Array<{ name: string; status: string; latencyMs: number }> })?.components || [];

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col span={6}><Card><Statistic title="Token用量" value={(Number(l.todayTokens) || 0).toLocaleString()} suffix={`/ ${(Number(l.dailyLimit) || 500000).toLocaleString()}`} />
          <Progress percent={Math.min(100, ((Number(l.todayTokens) || 0) / (Number(l.dailyLimit) || 500000)) * 100)} size="small" status={Number(l.todayTokens) > Number(l.dailyLimit) * 0.8 ? "exception" : "active"} /></Card></Col>
        <Col span={6}><Card><Statistic title="汇率 CNY→RUB" value={Number(f.rate) || 0} suffix={f.reliable ? "✅" : "⚠️"} /></Card></Col>
        <Col span={6}><Card><Statistic title="爬虫成功率" value={String(s.successRate) || "N/A"} /></Card></Col>
        <Col span={6}><Card><Statistic title="死信积压" value={deadList.length} valueStyle={{ color: deadList.length > 5 ? "#ef4444" : "#10b981" }} /></Card></Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card title="外部依赖状态" size="small">
            {components.map((c: { name: string; status: string; latencyMs: number }) => (
              <div key={c.name} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #f0f0f0" }}>
                <span>{c.name}</span>
                <Tag color={c.status === "ok" ? "green" : c.status === "degraded" ? "orange" : "red"}>{c.status} ({c.latencyMs}ms)</Tag>
              </div>
            ))}
          </Card>
        </Col>
        <Col span={12}>
          <Card title="死信队列" size="small">
            <Table dataSource={deadList.slice(0, 5)} rowKey="id" size="small" pagination={false}
              columns={[
                { title: "类型", dataIndex: "taskType", width: 80 }, { title: "错误", dataIndex: "errorMessage", ellipsis: true },
                { title: "重试", dataIndex: "retryCount", width: 50 },
              ]}
              locale={{ emptyText: "✅ 死信队列为空" }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
