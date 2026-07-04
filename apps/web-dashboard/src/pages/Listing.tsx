import { useState } from "react";
import { Card, Input, Button, Table, Tag, message, Space, Upload } from "antd";
import { UploadOutlined, LinkOutlined } from "@ant-design/icons";
import { listingApi, taskApi } from "../api/client";
import { useQuery } from "@tanstack/react-query";

export default function Listing() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
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

  const records = (Array.isArray((listings as { data?: unknown[] })?.data) ? (listings as { data: unknown[] }).data : []);

  return (
    <div>
      <Card title="产品上架" style={{ marginBottom: 16 }}>
        <Space.Compact style={{ width: "100%" }}>
          <Input prefix={<LinkOutlined />} placeholder="粘贴 1688 商品链接 https://detail.1688.com/offer/..." value={url} onChange={(e) => setUrl(e.target.value)} onPressEnter={submitUrl} size="large" />
          <Button type="primary" size="large" loading={loading} onClick={submitUrl}>一键上架</Button>
        </Space.Compact>
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
    </div>
  );
}
