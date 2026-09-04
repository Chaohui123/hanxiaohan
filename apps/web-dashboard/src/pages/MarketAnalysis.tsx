import { useState } from "react";
import { Card, Row, Col, Statistic, Table, Tag, Tabs, Button, Space, DatePicker, message } from "antd";
import { ReloadOutlined, ExportOutlined, RocketOutlined, DollarOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import {
  useMarketDetail, useMarketSnapshots, useRunMarket,
  type CategoryItem, type KeywordItem,
} from "../api/market-api";
import PageContainer from "../components/PageContainer";
import QueryState from "../components/QueryState";

export default function MarketAnalysis() {
  const [date, setDate] = useState(dayjs().format("YYYY-MM-DD"));
  const navigate = useNavigate();

  // queryKey 含日期：切换日期天然隔离缓存，慢响应不会覆盖新日期的数据
  const detailQuery = useMarketDetail(date);
  const { data: snapshots } = useMarketSnapshots();
  const runMarket = useRunMarket();

  const handleRun = () => {
    message.loading("正在执行大盘分析...");
    runMarket.mutate(undefined, {
      onSuccess: (d) => message.success(`任务已启动: ${d?.id || ""}`),
      onError: (e) => message.error(e.message),
    });
  };

  const exportExcel = () => {
    window.open(`/api/market/report-by-date/${date}`, "_blank");
  };

  // ---- Tab: 行业类目 ----
  const categoryColumns = [
    { title:"类目", dataIndex:"name", key:"name" },
    { title:"销量", dataIndex:"sales", key:"sales", sorter:(a:CategoryItem,b:CategoryItem)=>a.sales-b.sales },
    { title:"毛利率%", dataIndex:"margin", key:"margin", render:(v:number)=>`${v}%` },
    { title:"竞争度", dataIndex:"competition", key:"comp", render:(v:string)=><Tag color={v==="high"?"red":v==="medium"?"orange":"green"}>{v}</Tag> },
    { title:"标签", dataIndex:"label", key:"label", render:(v:string)=><Tag color={v==="红海"?"red":"blue"}>{v}</Tag> },
    { title:"流量占比%", dataIndex:"traffic", key:"traffic", render:(v:number)=>`${v}%` },
  ];

  // ---- Tab: 关键词 ----
  const kwColumns = [
    { title:"关键词", dataIndex:"word", key:"word" },
    { title:"搜索量", dataIndex:"volume", key:"vol", render:(v:number)=>v.toLocaleString(), sorter:(a:KeywordItem,b:KeywordItem)=>a.volume-b.volume },
    { title:"CPC(₽)", dataIndex:"cpc", key:"cpc" },
    { title:"竞争度", dataIndex:"competition", key:"comp", render:(v:string)=><Tag color={v==="high"?"red":v==="medium"?"orange":"green"}>{v}</Tag> },
    { title:"商品数", dataIndex:"products", key:"prods", render:(v:number)=>v.toLocaleString() },
    { title:"标签", dataIndex:"tag", key:"tag", render:(v:string)=><Tag color={v==="蓝海词"?"blue":v==="高转化"?"green":"orange"}>{v}</Tag> },
  ];

  // ---- Tab: 同行比价 ----
  const compColumns = [
    { title:"竞品", dataIndex:"name", key:"name" },
    { title:"价格₽", dataIndex:"price", key:"price" },
    { title:"月销", dataIndex:"sales", key:"sales", render:(v:number)=>v.toLocaleString() },
    { title:"评分", dataIndex:"rating", key:"rating" },
    { title:"价格优势", dataIndex:"advantage", key:"adv", render:(v:string)=><Tag color={v==="high"?"green":v==="medium"?"orange":"red"}>{
      v==="high"?"优势":v==="medium"?"持平":"劣势"}</Tag> },
  ];

  // ---- Tab: 成本 ----
  const costColumns = [
    { title:"成本项", dataIndex:"category", key:"cat" },
    { title:"金额₽", dataIndex:"amount", key:"amt" },
    { title:"占比", dataIndex:"percent", key:"pct", render:(v:number)=>`${v}%` },
  ];

  return (
    <PageContainer
      title="大盘分析"
      subTitle="每日大盘快照：类目、关键词、竞品与成本"
      updatedAt={detailQuery.dataUpdatedAt}
      extra={
        <Space wrap>
          <DatePicker value={dayjs(date)} onChange={(d) => setDate(d?.format("YYYY-MM-DD") || date)} allowClear={false} />
          <Button type="primary" icon={<ReloadOutlined />} loading={runMarket.isPending} onClick={handleRun}>立即更新大盘</Button>
          <Button icon={<ExportOutlined />} onClick={exportExcel}>导出Excel</Button>
          <Button icon={<RocketOutlined />} onClick={() => navigate("/listing")}>去上架</Button>
          <Button icon={<DollarOutlined />} onClick={() => navigate("/pricing-history")}>去调价</Button>
          {snapshots && snapshots.length > 0 && (
            <span style={{color:"#888",fontSize:12}}>上次执行: {snapshots[0]?.created_at?.slice(0,19)||"—"}</span>
          )}
        </Space>
      }
    >
      <QueryState query={detailQuery} emptyText="暂无大盘数据，点击「立即更新大盘」生成今日数据">
        {(data) => (
          <Tabs defaultActiveKey="overview" items={[
            { key:"overview", label:"📊 大盘总览", children: (
              <div>
                <Row gutter={[16,16]} style={{marginBottom:16}}>
                  <Col xs={12} sm={4}><Card><Statistic title="类目总销量" value={data.overview.totalSales} suffix="件"/></Card></Col>
                  <Col xs={12} sm={4}><Card><Statistic title="平均毛利率" value={data.overview.avgMargin} suffix="%" precision={2}/></Card></Col>
                  <Col xs={12} sm={4}><Card><Statistic title="蓝海商品" value={data.overview.blueOceanCount} valueStyle={{color:"#10b981"}}/></Card></Col>
                  <Col xs={12} sm={4}><Card><Statistic title="待调价" value={data.overview.pendingAdjust} valueStyle={{color:"#f59e0b"}}/></Card></Col>
                  <Col xs={12} sm={4}><Card><Statistic title="广告均价" value={data.overview.avgCpc} suffix="₽"/></Card></Col>
                  <Col xs={12} sm={4}><Card><Statistic title="今日上架" value={data.listedCount} valueStyle={{color:"#3b82f6"}}/></Card></Col>
                </Row>
                <Card title="LLM 分析结论" style={{background:"#f0f5ff"}}>
                  <p style={{fontSize:14}}>{data.llmReport || "暂无分析报告，点击「立即更新大盘」生成"}</p>
                </Card>
              </div>
            ) },
            { key:"categories", label:"🏪 行业类目", children:<Table dataSource={data.categories} columns={categoryColumns} rowKey="name" size="small" pagination={false} /> },
            { key:"products", label:"📦 单品分析", children:<Table dataSource={data.products} columns={[
              {title:"商品",dataIndex:"title",key:"t"},{title:"¥",dataIndex:"price",key:"p"},{title:"评分",dataIndex:"score",key:"s",render:(v:number)=><Tag color={v>=60?"green":"orange"}>{v}</Tag>},{title:"月销",dataIndex:"monthlySales",key:"ms"},{title:"利润¥",dataIndex:"profit",key:"pr"}]} rowKey="title" size="small" pagination={false} /> },
            { key:"keywords", label:"🔑 关键词", children:<Table dataSource={data.keywords} columns={kwColumns} rowKey="word" size="small" pagination={false} /> },
            { key:"costs", label:"💰 成本拆解", children:<Table dataSource={data.costs} columns={costColumns} rowKey="category" size="small" pagination={false} /> },
            { key:"competitors", label:"👥 同行比价", children:<Table dataSource={data.competitors} columns={compColumns} rowKey="name" size="small" pagination={false} /> },
          ]} />
        )}
      </QueryState>
    </PageContainer>
  );
}
