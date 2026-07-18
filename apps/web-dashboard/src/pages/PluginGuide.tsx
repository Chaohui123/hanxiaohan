import { Card, Steps, Button, Table, Tag, Space, message } from "antd";
import { DownloadOutlined, ChromeOutlined, LinkOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useQuery } from "@tanstack/react-query";

export default function PluginGuide() {
  const { data: pluginList } = useQuery({
    queryKey: ["plugin-products"],
    queryFn: () => api.get("/api/crawl/plugin-list") as Promise<{ data?: Array<Record<string, string>>; count?: number }>,
    refetchInterval: 15000,
  });

  const products = pluginList?.data || [];

  const columns = [
    { title: "商品", dataIndex: "title", key: "title", ellipsis: true, render: (v: string) => v?.slice(0, 50) },
    { title: "价格¥", dataIndex: "price_cny", key: "price", width: 80 },
    {
      title: "来源", key: "source", width: 100,
      render: () => <Tag color="purple">1688插件</Tag>,
    },
    {
      title: "操作", key: "action", width: 120,
      render: (_: unknown, r: Record<string, string>) => (
        <Button size="small" onClick={() => window.open(r.source_url, "_blank")}>查看1688</Button>
      ),
    },
  ];

  return (
    <div>
      <Card title="🔌 1688采购助手插件" style={{ marginBottom: 16 }}>
        <Steps
          direction="vertical"
          current={-1}
          items={[
            {
              title: "下载插件",
              description: (
                <Space>
                  <Button icon={<DownloadOutlined />} onClick={() => {
                    message.info("正在打包，请稍后...");
                    window.open("/api/crawl/plugin-download", "_blank");
                  }}>下载 CRX 安装包</Button>
                  <span style={{ color: "#888", fontSize: 12 }}>或从 GitHub Releases 下载</span>
                </Space>
              ),
            },
            {
              title: "安装插件",
              description: (
                <div style={{ fontSize: 12, color: "#888" }}>
                  1. 打开 Chrome 浏览器，地址栏输入 <code>chrome://extensions/</code><br />
                  2. 右上角开启 <strong>开发者模式</strong><br />
                  3. 将下载的 .crx 文件拖入浏览器窗口<br />
                  4. 点击插件图标，输入 API Key 保存
                </div>
              ),
            },
            {
              title: "开始采集",
              description: (
                <div style={{ fontSize: 12, color: "#888" }}>
                  打开任意 1688 商品详情页 → 右下角自动弹出 ONZO 面板 → 点击「同步至ERP」
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="📋 插件采集记录"
        extra={
          <Space>
            <Tag color="purple">{products.length} 条</Tag>
            <Button icon={<ChromeOutlined />} size="small" onClick={() => window.open("https://detail.1688.com", "_blank")}>
              去1688选品 <LinkOutlined />
            </Button>
          </Space>
        }
      >
        <Table dataSource={products.map((p, i) => ({ ...p, key: String(i) }))} columns={columns as never} size="small" pagination={{ pageSize: 20 }} />
      </Card>
    </div>
  );
}
