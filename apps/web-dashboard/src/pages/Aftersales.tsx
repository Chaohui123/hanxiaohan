import { useState } from "react";
import { Alert, Button, Card, Input, Modal, Space, Table, Tag, message } from "antd";
import { CheckOutlined, CloseOutlined, RobotOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aftersalesApi } from "../api/client";

const typeColors: Record<string, string> = { refund: "red", return: "orange", exchange: "blue", complaint: "purple", question: "green" };
const statusColors: Record<string, string> = { pending: "orange", processing: "blue", resolved: "green", rejected: "red" };

// 仅待处理状态允许操作
const ACTIONABLE_STATUSES = ["open", "pending"];

interface CaseRow {
  id: string;
  posting_number: string;
  type: string;
  status: string;
  reason: string;
  refund_amount_rub?: number;
  created_at: string;
}

interface AutoReplyResult {
  reply: string;
  confidence: number;
  source?: string;
}

export default function Aftersales() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["aftersales"], queryFn: () => aftersalesApi.list() });
  const cases = (Array.isArray((data as { data?: CaseRow[] })?.data) ? (data as { data: CaseRow[] }).data : []);

  const [noteModal, setNoteModal] = useState<{ mode: "resolve" | "reject"; row: CaseRow } | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [replyResult, setReplyResult] = useState<{ row: CaseRow; result: AutoReplyResult } | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["aftersales"] });

  const resolveMutation = useMutation({
    mutationFn: (args: { id: string; resolutionNote: string }) => aftersalesApi.resolve(args.id, args.resolutionNote),
    onSuccess: () => { message.success("已标记解决"); setNoteModal(null); setResolutionNote(""); invalidate(); },
    onError: (e: Error) => message.error(e.message),
  });

  const rejectMutation = useMutation({
    mutationFn: (args: { id: string; resolutionNote: string }) => aftersalesApi.reject(args.id, args.resolutionNote),
    onSuccess: () => { message.success("已拒绝该工单"); setNoteModal(null); setResolutionNote(""); invalidate(); },
    onError: (e: Error) => message.error(e.message),
  });

  const autoReplyMutation = useMutation({
    mutationFn: (id: string) => aftersalesApi.autoReply(id),
    onSuccess: (resp, id) => {
      const result = (resp as { data?: AutoReplyResult })?.data;
      const row = cases.find((c) => c.id === id);
      if (result && row) setReplyResult({ row, result });
      else message.warning("未获取到 AI 回复内容");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const submitNote = () => {
    if (!noteModal) return;
    if (!resolutionNote.trim()) { message.warning("请填写处理说明"); return; }
    const args = { id: noteModal.row.id, resolutionNote: resolutionNote.trim() };
    if (noteModal.mode === "resolve") resolveMutation.mutate(args);
    else rejectMutation.mutate(args);
  };

  return (
    <Card title="售后工单">
      <Table dataSource={cases} rowKey="id" loading={isLoading} size="small"
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
                    onClick={() => autoReplyMutation.mutate(r.id)}>AI 回复</Button>
                </Space>
              ) : null,
          },
        ]}
      />

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
  );
}
