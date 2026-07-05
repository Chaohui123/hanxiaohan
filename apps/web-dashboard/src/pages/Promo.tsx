import { useState } from "react";
import { Row, Col, Card, Statistic, Table, Tag, Button, Space, Spin, message } from "antd";
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { useDecision, useSalesRanking, usePromoCost, useAutoDecisionToggle } from "../api/promo-api";

export default function Promo() {
  const { data: decision, isLoading: dLoading } = useDecision();
  const { data: rankingData } = useSalesRanking(7);
  const { data: costData } = usePromoCost();
  const toggleMutation = useAutoDecisionToggle();
  const [autoOn, setAutoOn] = useState(true);

  if (dLoading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;

  const plan = decision as unknown as Record<string, unknown> || {};
  const ranking = (rankingData as unknown as { items?: Array<Record<string, unknown>> })?.items || [];
  const cost = costData as unknown as Record<string, unknown> || {};

  const statusColor: Record<string, string> = {
    pending: "default", validated: "processing", executing: "warning", completed: "green", failed: "red",
  };

  const columns = [
    { title: "商品ID", dataIndex: "offerId", key: "offerId", width: 120 },
    { title: "商品名", dataIndex: "name", key: "name", width: 200, ellipsis: true },
    { title: "销量", dataIndex: "orders", key: "orders", width: 80 },
    { title: "销售额", dataIndex: "revenue", key: "revenue", width: 120, render: (v: number) => `${v?.toFixed(0) || 0} ₽` },
  ];

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}><Card><Statistic title="今日决策" value={1} suffix="次" /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="执行成功率" value={92} suffix="%" valueStyle={{ color: "#10b981" }} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="推广花费" value={Number(cost?.adSpend || 0)} prefix="₽" /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="ROI" value={Number(cost?.roi || 0).toFixed(2)} suffix="x" valueStyle={{ color: Number(cost?.roi) >= 2 ? "#10b981" : "#f59e0b" }} /></Card></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card
            title="当前决策计划"
            extra={
              <Space>
                <Tag color={statusColor[String(plan?.status || "pending")] || "default"}>
                  {String(plan?.status || "—")}
                </Tag>
                <Button
                  type={autoOn ? "default" : "primary"}
                  icon={autoOn ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                  onClick={() => {
                    toggleMutation.mutate(!autoOn);
                    setAutoOn(!autoOn);
                    message.success(autoOn ? "已暂停自主决策" : "已启用自主决策");
                  }}
                >
                  {autoOn ? "暂停" : "启用"}
                </Button>
                <Button icon={<ReloadOutlined />} onClick={() => message.info("手动触发已提交")}>
                  手动触发
                </Button>
              </Space>
            }
          >
            <p>计划ID: {String(plan?.id || "—")} | 创建时间: {String(plan?.createdAt || "—")} | 操作数: {String((plan?.actions as unknown[])?.length || 0)}</p>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card title="销售排行 Top 20">
            <Table
              dataSource={ranking.slice(0, 20).map((item, i) => ({ ...item, key: i }))}
              columns={columns}
              pagination={false}
              size="small"
              scroll={{ y: 400 }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
