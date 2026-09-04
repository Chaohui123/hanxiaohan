import { useEffect, useState } from "react";
import { Row, Col, Card, Statistic, Table, Tag, Button, Space, Spin, Typography, message } from "antd";
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { promoApi, useDecision, useDecisionStats, useSalesRanking, usePromoCost, useAutoDecisionToggle } from "../../api/promo-api";
import { fromNow } from "../../utils/time";

export default function PromoDecision() {
  const { data: decision, isLoading: dLoading } = useDecision();
  const { data: decisionStats } = useDecisionStats();
  const { data: rankingData } = useSalesRanking(7);
  const { data: costData } = usePromoCost();
  const toggleMutation = useAutoDecisionToggle();
  const [autoOn, setAutoOn] = useState(true);
  const [triggering, setTriggering] = useState(false);

  // Sync from backend if the decision endpoint ever returns a switch field (currently none)
  useEffect(() => {
    const v = decision?.autoEnabled;
    if (typeof v === "boolean") setAutoOn(v);
  }, [decision]);

  if (dLoading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;

  const ranking = rankingData || [];
  const cost = costData || {};

  const agentReachable = decision?.agentReachable !== false;
  const planStatus = decision?.lastPlanStatus || "—";
  const fmtTime = (v?: string | null) => (v ? dayjs(v).format("MM-DD HH:mm") : "—");

  const statusColor: Record<string, string> = {
    pending: "default", validated: "processing", executing: "warning", completed: "green", failed: "red",
  };

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      await promoApi.triggerDecision();
      message.success("手动触发已提交");
    } catch (e) { message.error((e as Error).message); }
    finally { setTriggering(false); }
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
        <Col xs={12} sm={6}><Card><Statistic title="今日动作" value={decisionStats?.todayActions ?? 0} suffix="次" /></Card></Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic title="近 7 日动作" value={decisionStats?.weekActions ?? 0} suffix="次" valueStyle={{ color: "#10b981" }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              最近动作：{decisionStats?.lastActionAt ? fromNow(decisionStats.lastActionAt) : "暂无"}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} sm={6}><Card><Statistic title="推广花费" value={Number(cost?.adSpend || 0)} prefix="₽" /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="ROI" value={Number(cost?.roi || 0).toFixed(2)} suffix="x" valueStyle={{ color: Number(cost?.roi) >= 2 ? "#10b981" : "#f59e0b" }} /></Card></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24}>
          <Card
            title="当前决策计划"
            extra={
              <Space>
                {agentReachable ? (
                  <Tag color={statusColor[planStatus] || "default"}>{planStatus}</Tag>
                ) : (
                  <Tag>代理不可达</Tag>
                )}
                <Button
                  type={autoOn ? "default" : "primary"}
                  icon={autoOn ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                  loading={toggleMutation.isPending}
                  onClick={() => {
                    const next = !autoOn;
                    toggleMutation.mutate(next, {
                      onSuccess: () => {
                        setAutoOn(next);
                        message.success(next ? "已启用自主决策" : "已暂停自主决策");
                      },
                      onError: (e) => message.error((e as Error).message),
                    });
                  }}
                >
                  {autoOn ? "暂停" : "启用"}
                </Button>
                <Button icon={<ReloadOutlined />} loading={triggering} onClick={handleTrigger}>
                  手动触发
                </Button>
              </Space>
            }
          >
            {agentReachable ? (
              <p>计划ID: {decision?.lastPlanId || "—"} | 创建时间: {fmtTime(decision?.lastPlanCreatedAt)} | 操作数: {decision?.lastPlanActionCount || 0} | 执行时间: {fmtTime(decision?.lastPlanExecutedAt)}</p>
            ) : (
              <Typography.Text type="secondary">代理不可达 — 无法获取当前决策计划</Typography.Text>
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24}>
          <Card title="销售排行 Top 20">
            <Table
              dataSource={ranking.slice(0, 20).map((item, i) => ({ ...item, key: i }))}
              columns={columns}
              pagination={false}
              size="small"
              scroll={{ x: "max-content", y: 400 }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
