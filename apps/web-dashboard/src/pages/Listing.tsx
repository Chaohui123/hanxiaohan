import { useState } from "react";
import { Card, Input, Button, Table, Tag, message, Space, Upload, Modal } from "antd";
import { UploadOutlined, LinkOutlined, RocketOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { listingApi, taskApi } from "../api/client";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export default function Listing() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [fullLaunching, setFullLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<Record<string, unknown> | null>(null);
  const { data: listings, refetch } = useQuery({ queryKey: ["listings-full"], queryFn: () => taskApi.listings() });

  const submitUrl = async () => {
    if (!url.trim()) return message.warning("请输入 1688 商品链接");
    setLoading(true);
    try {
      await listingApi.submit(url.trim());
      message.success("上架任务已提交");
      setUrl("");
      refetch();
    } catch (err) { message.error((err as Error).message); }
    finally { setLoading(false); }
  };

  // Full pipeline: analysis → listing → ads → orders → profit
  const launchFullPipeline = async () => {
    if (!url.trim()) return message.warning("请输入 1688 商品链接");
    setFullLaunching(true);
    try {
      const resp = await api.post("/api/product/launch", { sourceUrl: url.trim(), storeId: "store_1" });
      const data = resp.data as Record<string, unknown>;
      setLaunchResult(data);
      message.success(`全闭环已启动 — taskId: ${data.taskId || "?"}`);
      setUrl("");
    } catch (err) { message.error((err as Error).message); }
    finally { setFullLaunching(false); }
  };

  const records = (Array.isArray((listings as { data?: unknown[] })?.data) ? (listings as { data: unknown[] }).data : []);

  return (
    <div>
      <Card title="产品上架" style={{ marginBottom: 16 }}>
        <Space.Compact style={{ width: "100%" }}>
          <Input prefix={<LinkOutlined />} placeholder="粘贴 1688 商品链接 https://detail.1688.com/offer/..." value={url} onChange={(e) => setUrl(e.target.value)} onPressEnter={submitUrl} size="large" />
          <Button type="primary" size="large" loading={loading} onClick={submitUrl}>一键上架</Button>
          <Button icon={<RocketOutlined />} size="large" loading={fullLaunching} onClick={launchFullPipeline}
            style={{ background: "#722ed1", borderColor: "#722ed1", color: "#fff" }}>
            一键全流程
          </Button>
        </Space.Compact>
        <div style={{ marginTop: 8, color: "#888", fontSize: 12 }}>
          一键全流程：选品分析 → Ozon上架 → 创建推广 → 订单同步 → 利润核算
        </div>
        <div style={{ marginTop: 12 }}>
          <Upload accept=".csv,.xlsx" showUploadList={false} beforeUpload={() => false}>
            <Button icon={<UploadOutlined />}>批量导入 CSV/Excel</Button>
          </Upload>
        </div>
      </Card>

      <Card title="上架记录">
        <Table dataSource={records} rowKey="id" size="small" pagination={{ pageSize: 20 }}
          columns={[
            { title: "URL", dataIndex: "sourceUrl", ellipsis: true },
            { title: "状态", dataIndex: "status", render: (s: string) => <Tag color={s === "done" ? "green" : s === "failed" ? "red" : "blue"}>{s}</Tag> },
            { title: "草稿ID", dataIndex: "draftId" },
            { title: "时间", dataIndex: "createdAt", width: 160 },
          ]}
        />
      </Card>

      <Modal title="全流程启动结果" open={!!launchResult} onCancel={() => setLaunchResult(null)} footer={null}>
        {launchResult && (
          <div style={{ lineHeight: 2 }}>
            <p><strong>Task ID：</strong>{launchResult.taskId as string}</p>
            <p><strong>状态：</strong>{String(launchResult.status)}</p>
            <p style={{ color: "#888", fontSize: 12 }}>
              通过 GET /api/workflow/status?taskId=... 查询执行进度
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
