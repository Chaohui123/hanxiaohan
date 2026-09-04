import { useState } from "react";
import { Alert, Button, Card, Input, Modal, Space, Table, Tag, message } from "antd";
import { CheckOutlined, CloseOutlined, RobotOutlined } from "@ant-design/icons";
import {
  useAftersalesCases, useResolveCase, useRejectCase, useAutoReply,
  type CaseRow, type AutoReplyResult,
} from "../api/aftersales-api";
import PageContainer from "../components/PageContainer";
import QueryState from "../components/QueryState";

const typeColors: Record<string, string> = { refund: "red", return: "orange", exchange: "blue", complaint: "purple", question: "green" };
const statusColors: Record<string, string> = { pending: "orange", processing: "blue", resolved: "green", rejected: "red" };

// 仅待处理状态允许操作
const ACTIONABLE_STATUSES = ["open", "pending"];

export default function Aftersales() {
  const casesQuery = useAftersalesCases();

  const [noteModal, setNoteModal] = useState<{ mode: "resolve" | "reject"; row: CaseRow } | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [replyResult, setReplyResult] = useState<{ row: CaseRow; result: AutoReplyResult } | null>(null);

  const resolveMutation = useResolveCase();
  const rejectMutation = useRejectCase();
  const autoReplyMutation = useAutoReply();

  const submitNote = () => {
    if (!noteModal) return;
    if (!resolutionNote.trim()) { message.warning("请填写处理说明"); return; }
    const args = { id: noteModal.row.id, resolutionNote: resolutionNote.trim() };
    const callbacks = {
      onSuccess: () => {
        message.success(noteModal.mode === "resolve" ? "已标记解决" : "已拒绝该工单");
        setNoteModal(null);
        setResolutionNote("");
      },
      onError: (e: Error) => message.error(e.message),
    };
    if (noteModal.mode === "resolve") resolveMutation.mutate(args, callbacks);
    else rejectMutation.mutate(args, callbacks);
  };

  return (
    <PageContainer title="售后工单" subTitle="退款/退货/投诉工单处理与 AI 回复" updatedAt={casesQuery.dataUpdatedAt}>
      <Card>
        <QueryState query={casesQuery} emptyText="暂无售后工单">
          {(cases) => (
            <Table dataSource={cases} rowKey="id" size="small"
              columns={[
                { title: "订单号", dataIndex: "posting_number", width: 130 },
                { title: "类型", dataIndex: "type", render: (t: string) => <Tag color={typeColors[t] || "default"}>{t}</Tag> },
                { title: "状态", dataIndex: "status", render: (s: string) => <Tag color={statusColors[s] || "default"}>{s}</Tag> },
                { title: "原因", dataIndex: "reason" },
                { title: "退款", dataIndex: "refund_amount_rub", render: (v: number) => v ? `${v} ₽` : "-" },
                { title: "时间", dataIndex: "created_at", width: 160 },
                {
                  title: "操作", width: 210, render: (_: unknown, r: CaseRow) =>
                    ACTIONABLE_STATUSES.includes(r.status) ? (
                      <Space size={4}>
                        <Button size="small" type="primary" ghost icon={<CheckOutlined />}
                          onClick={() => { setNoteModal({ mode: "resolve", row: r }); setResolutionNote(""); }}>解决</Button>
                        <Button size="small" danger icon={<CloseOutlined />}
                          onClick={() => { setNoteModal({ mode: "reject", row: r }); setResolutionNote(""); }}>拒绝</Button>
                        <Button size="small" icon={<RobotOutlined />}
                          loading={autoReplyMutation.isPending && autoReplyMutation.variables === r.id}
                          onClick={() => autoReplyMutation.mutate(r.id, {
                            onSuccess: (result) => {
                              if (result) setReplyResult({ row: r, result });
                              else message.warning("未获取到 AI 回复内容");
                            },
                            onError: (e) => message.error((e as Error).message),
                          })}>AI 回复</Button>
                      </Space>
                    ) : null,
                },
              ]}
            />
          )}
        </QueryState>

        <Modal
          title={noteModal?.mode === "resolve" ? `解决工单 — ${noteModal?.row.posting_number ?? ""}` : `拒绝工单 — ${noteModal?.row.posting_number ?? ""}`}
          open={!!noteModal}
          onOk={submitNote}
          onCancel={() => { setNoteModal(null); setResolutionNote(""); }}
          okText={noteModal?.mode === "resolve" ? "确认解决" : "确认拒绝"}
          cancelText="取消"
          confirmLoading={resolveMutation.isPending || rejectMutation.isPending}
        >
          <div style={{ marginBottom: 4, fontWeight: 500 }}>处理说明（必填）</div>
          <Input.TextArea
            rows={4}
            value={resolutionNote}
            onChange={(e) => setResolutionNote(e.target.value)}
            placeholder="填写处理结果说明，将记录到工单"
          />
        </Modal>

        <Modal
          title={`AI 回复 — ${replyResult?.row.posting_number ?? ""}`}
          open={!!replyResult}
          onCancel={() => setReplyResult(null)}
          footer={<Button type="primary" onClick={() => setReplyResult(null)}>关闭</Button>}
          width={560}
        >
          {replyResult && (
            <Space direction="vertical" style={{ width: "100%" }} size="middle">
              {replyResult.result.confidence < 0.7 && (
                <Alert type="warning" showIcon message="AI 置信度低，请人工审核后再发送" />
              )}
              <div>
                置信度：
                <Tag color={replyResult.result.confidence >= 0.7 ? "green" : "orange"}>
                  {(replyResult.result.confidence * 100).toFixed(0)}%
                </Tag>
                {replyResult.result.source && <Tag>{replyResult.result.source}</Tag>}
              </div>
              <div style={{ whiteSpace: "pre-wrap", background: "#f5f5f5", padding: 12, borderRadius: 6 }}>
                {replyResult.result.reply || "（无内容）"}
              </div>
            </Space>
          )}
        </Modal>
      </Card>
    </PageContainer>
  );
}
