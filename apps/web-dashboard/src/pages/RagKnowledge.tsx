import { useState } from "react";
import { Row, Col, Card, Statistic, Table, Input, Select, Button, Space, Tag, Spin, message, Tabs, Form, Modal } from "antd";
import { SearchOutlined, ImportOutlined, PlusOutlined } from "@ant-design/icons";
import { useRagStats, useRagSearch, useRagAdd, useRagImport, kbLabels } from "../api/rag-api";

const kbOptions = Object.entries(kbLabels).map(([value, label]) => ({ value, label }));

export default function RagKnowledge() {
  const { data: statsData, isLoading: statsLoading } = useRagStats();
  const [searchKb, setSearchKb] = useState("aftersales");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const { data: searchResults, isLoading: searchLoading } = useRagSearch(searchKb, activeQuery);
  const addMutation = useRagAdd(searchKb);
  const importMutation = useRagImport(searchKb);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();

  const stats = statsData as unknown as Record<string, number> || {};

  const handleSearch = () => {
    if (!searchQuery.trim()) { message.warning("请输入查询文本"); return; }
    setActiveQuery(searchQuery.trim());
  };

  const results = (searchResults as unknown as { results?: Array<Record<string, unknown>> })?.results || [];

  const searchColumns = [
    { title: "相似度", dataIndex: "score", key: "score", width: 80, render: (v: number) => (v * 100).toFixed(1) + "%" },
    { title: "内容", dataIndex: "content", key: "content", ellipsis: true, render: (_: unknown, r: Record<string, unknown>) =>
      String(r.content || r.content_ru || r.report_text || r.original_text || "") },
    { title: "来源", dataIndex: "source", key: "source", width: 80 },
  ];

  return (
    <div>
      <Row gutter={[16, 16]}>
        {Object.entries(kbLabels).map(([key, label]) => (
          <Col xs={12} sm={6} lg={4} key={key}>
            <Card>
              <Statistic title={label} value={stats[key] || 0} loading={statsLoading} />
            </Card>
          </Col>
        ))}
        <Col xs={12} sm={6} lg={4}>
          <Card>
            <Statistic title="总计" value={Object.values(stats).reduce((s, n) => s + (n || 0), 0)} loading={statsLoading} valueStyle={{ color: "#3b82f6" }} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card title="向量搜索测试" extra={
            <Space>
              <Select value={searchKb} onChange={setSearchKb} options={kbOptions} style={{ width: 120 }} />
              <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>搜索</Button>
            </Space>
          }>
            <Input.Search
              placeholder="输入查询文本..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onSearch={handleSearch}
              style={{ marginBottom: 12 }}
            />
            <Table
              dataSource={results.map((r, i) => ({ ...r, key: i }))}
              columns={searchColumns}
              pagination={false}
              size="small"
              loading={searchLoading}
              locale={{ emptyText: activeQuery ? "无匹配结果" : "输入查询后搜索" }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card title="数据管理" extra={
            <Space>
              <Button icon={<ImportOutlined />} onClick={() => importMutation.mutate(undefined as unknown as void, { onSuccess: (d: unknown) => message.success(`已导入 ${(d as Record<string, number>).imported || 0} 条`) })} loading={importMutation.isPending}>
                批量导入
              </Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>添加文档</Button>
            </Space>
          }>
            <Tabs items={Object.entries(kbLabels).map(([key, label]) => ({
              key, label: `${label} (${stats[key] || 0})`,
              children: <div style={{ padding: 24, textAlign: "center", color: "#94a3b8" }}>
                选择知识库后在搜索面板中查询，或点击"添加文档"手动录入
              </div>,
            }))} />
          </Card>
        </Col>
      </Row>

      <Modal title="添加知识文档" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={() => {
        form.validateFields().then((values) => {
          addMutation.mutate(values, {
            onSuccess: (d: unknown) => { message.success(`已添加: ${(d as Record<string, string>).id}`); setModalOpen(false); form.resetFields(); },
            onError: (e: Error) => message.error(e.message),
          });
        });
      }}>
        <Form form={form} layout="vertical">
          <Form.Item label="知识库类型">
            <Select value={searchKb} onChange={setSearchKb} options={kbOptions} />
          </Form.Item>
          {searchKb === "aftersales" && <>
            <Form.Item name="category" label="分类" rules={[{ required: true }]}>
              <Select options={["refund","return","exchange","complaint","question"].map(v => ({value:v,label:v}))} />
            </Form.Item>
            <Form.Item name="scenario" label="场景" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="contentRu" label="俄语话术" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          </>}
          {(searchKb === "playbook" || searchKb === "product") && <>
            <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="content" label="内容" rules={[{ required: true }]}><Input.TextArea rows={4} /></Form.Item>
            {searchKb === "playbook" && <Form.Item name="scenario" label="场景" rules={[{ required: true }]}>
              <Select options={["pricing","listing","aftersales","promotion","inventory"].map(v => ({value:v,label:v}))} />
            </Form.Item>}
          </>}
          {(searchKb === "copy" || searchKb === "competitor") && <>
            <Form.Item name={searchKb === "copy" ? "originalText" : "reportText"} label="文本内容" rules={[{ required: true }]}>
              <Input.TextArea rows={4} />
            </Form.Item>
            {searchKb === "copy" && <Form.Item name="category" label="分类" rules={[{ required: true }]}>
              <Select options={["product_title","product_desc","ad_copy"].map(v => ({value:v,label:v}))} />
            </Form.Item>}
            {searchKb === "competitor" && <Form.Item name="offerId" label="Offer ID" rules={[{ required: true }]}><Input /></Form.Item>}
          </>}
        </Form>
      </Modal>
    </div>
  );
}
