import { useState } from "react";
import { Alert, Button, Card, Descriptions, Modal, Space, Table, Tag, Typography, message } from "antd";
import { EyeOutlined, ReloadOutlined } from "@ant-design/icons";
import PageContainer from "../components/PageContainer";
import QueryState from "../components/QueryState";
import { useWordstatWeekly, wordstatWeeklyApi, type WeeklyObservation } from "../api/wordstat-weekly";

function number(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

export default function WordstatWeekly() {
  const query = useWordstatWeekly();
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);

  const previewCard = async () => {
    setPreviewing(true);
    try {
      const result = await wordstatWeeklyApi.preview();
      if (result.status === "NO_REPORT") {
        message.info("云端尚未生成报告，没有伪造预览数据");
        return;
      }
      setPreview(result);
      message.success("已生成卡片预览，未写数据库、未发送飞书");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <PageContainer
      title="Wordstat 云端选品观察"
      subTitle="Yandex Cloud Functions + Timer + Object Storage；ONZO回读，仅用于观察，不自动上架"
      updatedAt={query.dataUpdatedAt}
      extra={<Space><Tag color="blue">云端Wordstat</Tag><Button icon={<ReloadOutlined />} onClick={() => query.refetch()}>刷新</Button><Button icon={<EyeOutlined />} loading={previewing} onClick={previewCard}>卡片预览（不发送）</Button></Space>}
    >
      <QueryState query={query} emptyText="尚无云端周报；Seller本机采集与旧报告不受影响">
        {report => {
          if (!report) return null;
          const observations = report.top10Observations || [];
          const stale = observations.some(item => item.freshnessStatus === "stale_expired" || item.freshnessStatus === "no_data");
          return (
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
              {report.overallStatus === "failed_alert_only" && <Alert type="error" showIcon message="云端采集失败或结果不明" description="已保留失败与上一份成功报告；Timer重试不得再次请求上游，先核对事件账本。" />}
              {stale && <Alert type="warning" showIcon message="部分周序列已过期或未返回" description="页面保留原始数据截止时间，不把历史周冒充本周，也不将缺失补0。" />}
              <Alert type="info" showIcon message="观察分不是选品合格结论" description="仍须竞争、供货、准确变体、真实单元经济、合规、8图双视频和独立复核；季节性提示不用于提前备货。" />
              <Card>
                <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
                  <Descriptions.Item label="报告ID">{report.reportId}</Descriptions.Item>
                  <Descriptions.Item label="运行日期">{report.runDate}</Descriptions.Item>
                  <Descriptions.Item label="实际数据截止">{report.globalSourceAsOfMax || "未返回"}</Descriptions.Item>
                  <Descriptions.Item label="报告状态"><Tag color={report.overallStatus === "success" ? "green" : report.overallStatus === "degraded_partial" ? "orange" : "red"}>{report.overallStatus}</Tag></Descriptions.Item>
                  <Descriptions.Item label="Seller覆盖">{report.sellerValidationContext.selfBuiltProgressLabel}（{report.sellerValidationContext.selfBuiltCoverageStatus || "未知"}）</Descriptions.Item>
                  <Descriptions.Item label="最新Seller原生批次">{report.sellerValidationContext.nativeWindowDays === 7 ? `${report.sellerValidationContext.nativeBatchPages ?? "—"}页 / ${report.sellerValidationContext.nativeBatchRows?.toLocaleString() ?? "—"}条` : "尚无可用原生7天批次"}</Descriptions.Item>
                  <Descriptions.Item label="Seller批次时间">{report.sellerValidationContext.nativeBatchCollectedAt || "未返回"}</Descriptions.Item>
                  <Descriptions.Item label="通知状态">{report.notification?.status || "未发送"}</Descriptions.Item>
                  <Descriptions.Item label="原始回执数">{report.rawReceiptKeys.length}</Descriptions.Item>
                  <Descriptions.Item label="原始SHA-256"><Typography.Text copyable={{ text: report.storage?.sha256 || "" }}>{report.storage?.sha256 || "—"}</Typography.Text></Descriptions.Item>
                </Descriptions>
              </Card>
              <Table<WeeklyObservation>
                rowKey="phrase"
                dataSource={observations}
                scroll={{ x: 1250 }}
                pagination={false}
                columns={[
                  { title: "俄语观察词 / 中文辅助草稿", key: "phrase", fixed: "left", width: 310, render: (_, row) => <Space direction="vertical" size={2}><Typography.Text strong>{row.phrase}</Typography.Text><Typography.Text type="secondary">{row.zhDraft}</Typography.Text><Space><Button size="small" href={row.yandexSearchUrl} target="_blank" rel="noreferrer">Yandex</Button><Button size="small" href={row.ozonSearchUrl} target="_blank" rel="noreferrer">Ozon</Button></Space></Space> },
                  { title: "有效周量", dataIndex: "effectiveWeeklyVolume", width: 120, render: value => value === null || value === undefined ? "—" : Number(value).toLocaleString("ru-RU") },
                  { title: "WoW（完整连续周）", dataIndex: "wowRate", width: 170, render: value => value === null || value === undefined ? "—" : `${(Number(value) * 100).toFixed(2)}%` },
                  { title: "观察分（非上架资格）", key: "score", width: 180, render: (_, row) => <Space direction="vertical" size={0}><span>{number(row.score.observationPriorityScore)}</span><Typography.Text type="secondary">{row.score.scoreStatus}</Typography.Text></Space> },
                  { title: "数据截止 / 滞后", key: "source", width: 160, render: (_, row) => `${row.sourceAsOf || "未返回"}${row.lagDaysFromRun === null ? "" : ` / ${row.lagDaysFromRun}天`}` },
                  { title: "城市原始share / affinityIndex", key: "cities", width: 310, render: (_, row) => <Space direction="vertical" size={0}>{row.referenceCities.map(city => <span key={city.nameZh}>{city.nameZh}：{city.rawShare === null ? "—" : number(city.rawShare, 6)} / {number(city.affinityIndex)}</span>)}</Space> },
                  { title: "季节性补证提示", key: "seasonality", width: 300, render: (_, row) => <Typography.Text type={row.seasonality.status === "upcoming_peak_window" ? "warning" : "secondary"}>{row.seasonality.uncertaintyNote}</Typography.Text> },
                ]}
              />
              {report.failedRequests.length > 0 && <Alert type="error" showIcon message="请求失败与缺口" description={report.failedRequests.map(item => `${item.phrase}：${item.errorType}（${item.httpStatus ?? "未知"}）`).join("；")} />}
              <Card title="口径与使用边界" size="small"><ul>{report.disclaimers.map(item => <li key={item}>{item}</li>)}</ul></Card>
            </Space>
          );
        }}
      </QueryState>
      <Modal title="飞书卡片 dry-run 预览（不发送）" open={preview !== null} onCancel={() => setPreview(null)} footer={<Button onClick={() => setPreview(null)}>关闭</Button>} width={850}>
        <Alert type="info" showIcon message="本预览不写数据库、不调用飞书Webhook" />
        <pre style={{ maxHeight: 520, overflow: "auto", whiteSpace: "pre-wrap" }}>{JSON.stringify(preview?.card, null, 2)}</pre>
      </Modal>
    </PageContainer>
  );
}
