import { useState } from "react";
import { Card, Input, Button, Table, Tag, message, Space, Upload, Modal, Divider } from "antd";
import { UploadOutlined, LinkOutlined, RocketOutlined, SearchOutlined } from "@ant-design/icons";
import { listingApi, taskApi } from "../api/client";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export default function Listing() {
  const [url, setUrl] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [autoSelecting, setAutoSelecting] = useState(false);
  const [selectResult, setSelectResult] = useState<Record<string, unknown> | null>(null);
  const { data: listings, refetch } = useQuery({ queryKey: ["listings-full"], queryFn: () => taskApi.listings() });

  // Manual URL listing
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

  // Auto-select: keyword → Ops search → Promo score → cross-validate → auto-list
  const autoSelect = async () => {
    if (!keyword.trim()) return message.warning("请输入商品关键词");
    setAutoSelecting(true);
    try {
      const resp: unknown = await api.post("/api/auto-select", { keyword: keyword.trim() });
      const data = (resp as { data?: Record<string, unknown> }).data || (resp as Record<string, unknown>);
      setSelectResult(data);
      if ((data as { validationPassed?: boolean }).validationPassed) {
        message.success("自动选品上架成功！");
      } else {
        message.warning("已找到候选商品，但交叉验证未通过");
      }
      setKeyword("");
    } catch (err) { message.error((err as Error).message); }
    finally { setAutoSelecting(false); }
  };

  const records = (Array.isArray((listings as { data?: unknown[] })?.data) ? (listings as { data: unknown[] }).data : []);

  return (
    <div>
      {/* ---- 自动选品上架 ---- */}
      <Card title="🤖 自动选品上架（无需1688链接）" style={{ marginBottom: 16, borderColor: "#722ed1" }}>
        <div style={{ color: "#888", fontSize: 12, marginBottom: 8 }}>
          Ops-Agent 搜索1688 → Promo-Agent 评分排序 → 交叉验证 → 自动上架 + 推广
        </div>
        <Space.Compact style={{ width: "100%" }}>
          <Input prefix={<SearchOutlined />} placeholder="输入商品关键词，如：蓝牙耳机、手机壳、LED灯..." value={keyword} onChange={(e) => setKeyword(e.target.value)} onPressEnter={autoSelect} size="large" />
          <Button icon={<RocketOutlined />} size="large" loading={autoSelecting} onClick={autoSelect}
            style={{ background: "#722ed1", borderColor: "#722ed1", color: "#fff" }}>
            一键全流程
          </Button>
        </Space.Compact>
      </Card>

      {/* ---- 手动上架 ---- */}
      <Card title="📎 手动提交 1688 链接" style={{ marginBottom: 16 }}>
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

      {/* ---- Listing records ---- */}
      <Card title="上架记录">
        <Table dataSource={records} rowKey="id" size="small" pagination={{ pageSize: 20 }}
          columns={[
            { title: "URL", dataIndex: "sourceUrl", ellipsis: true },
            { title: "来源", dataIndex: "source", width: 80, render: (s: string) => <Tag color={s === "plugin" ? "purple" : "blue"}>{s === "plugin" ? "插件" : "大盘"}</Tag> },
            { title: "状态", dataIndex: "status", render: (s: string) => <Tag color={s === "done" ? "green" : s === "failed" ? "red" : "blue"}>{s}</Tag> },
            { title: "草稿ID", dataIndex: "draftId" },
            { title: "时间", dataIndex: "createdAt", width: 160 },
          ]}
        />
      </Card>

      {/* ---- Auto-Select Result Modal ---- */}
      <Modal title="自动选品结果" open={!!selectResult} onCancel={() => setSelectResult(null)} footer={null} width={650}>
        {selectResult && (
          <div style={{ lineHeight: 2.2 }}>
            <p><strong>关键词：</strong>{String((selectResult as Record<string, unknown>).keyword)}</p>
            <p><strong>候选商品：</strong>{String((selectResult as Record<string, unknown>).candidates)} 个</p>

            {/* Proper product display (not [object Object]) */}
            {(() => {
              const r = selectResult as Record<string, unknown>;
              const failType = String(r.validateFailType || "");
              const topProducts = (r.topScoreProducts as Array<{url:string;title:string;price:number;margin:number;finalScore:number}>) || [];
              const secondary = (r.secondarySort as Array<{url:string;title:string;price:number;margin:number;finalScore:number}>) || [];
              const passed = Boolean(r.validationPassed);

              if (topProducts.length >= 2 && failType === "multipleTopScore") {
                return (
                  <div style={{ background: "#fffbe6", border: "1px solid #fadb14", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                    <p style={{ color: "#ad6800", fontWeight: "bold" }}>
                      ⚠️ 存在 {topProducts.length} 款同分高分商品 ({String(r.topScore)}分)，请手动选择：
                    </p>
                    {secondary.map((p, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
                        <span style={{ flex: 1, fontSize: 13 }}>{p.title?.slice(0, 35)}</span>
                        <span style={{ width: 50 }}>¥{p.price}</span>
                        <span style={{ width: 50, color: (p.margin||0) > 20 ? "green" : "orange" }}>{p.margin||0}%</span>
                        <Button size="small" type="primary" style={{ marginLeft: 8 }}
                          onClick={async () => {
                            try {
                              await api.post("/api/market/manual-publish", { url: p.url });
                              message.success(`已上架: ${(p.title||"").slice(0, 20)}`);
                            } catch (e) { message.error((e as Error).message); }
                          }}>选定上架</Button>
                      </div>
                    ))}
                  </div>
                );
              }
              if (topProducts.length === 1 && topProducts[0]) {
                return (
                  <div style={{ background: "#f6ffed", padding: 12, borderRadius: 6 }}>
                    <p><strong>🏆 {topProducts[0].title?.slice(0, 40)}</strong></p>
                    <p>¥{topProducts[0].price} | 毛利 {topProducts[0].margin}% | {topProducts[0].finalScore}分</p>
                  </div>
                );
              }
              return null;
            })()}

            <p><strong>交叉验证：</strong>
              {(selectResult as Record<string, unknown>).validationPassed
                ? <Tag color="green">✅ 通过 — 已自动上架</Tag>
                : <Tag color="orange">⚠️ 未通过</Tag>}
            </p>

            {((selectResult as Record<string, unknown>).validationIssues as string[])?.length > 0 && (
              <div style={{ background: "#fff7e6", padding: 8, borderRadius: 4 }}>
                <strong>验证问题：</strong>
                {((selectResult as Record<string, unknown>).validationIssues as string[]).map((issue: string, i: number) => (
                  <div key={i} style={{ fontSize: 13, color: "#ad6800" }}>• {issue}</div>
                ))}
              </div>
            )}

            {Boolean((selectResult as Record<string, unknown>).listingTaskId) && (
              <p><strong>上架任务：</strong><code>{String((selectResult as Record<string, unknown>).listingTaskId)}</code></p>
            )}

            <Divider />
            <p style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#555", background: "#f5f5f5", padding: 8, borderRadius: 4 }}>
              {String((selectResult as Record<string, unknown>).report || "")}
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}