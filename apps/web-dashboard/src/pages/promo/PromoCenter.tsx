// PromoCenter — merged promo pages as tabs: decision / effect / pricing history
import { Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import PageContainer from "../../components/PageContainer";
import PromoDecision from "./PromoDecision";
import PromoEffect from "./PromoEffect";
import PromoPricingHistory from "./PromoPricingHistory";
import { useDecision, usePromoCost, usePricingHistory } from "../../api/promo-api";

const TAB_KEYS = ["decision", "effect", "pricing"];

export default function PromoCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") || "decision";
  const activeKey = TAB_KEYS.includes(tabParam) ? tabParam : "decision";

  // 与 Tab 内组件共用 queryKey 缓存，新鲜度标注取当前 Tab 的主查询
  const decisionQuery = useDecision();
  const costQuery = usePromoCost();
  const pricingQuery = usePricingHistory(30);
  const updatedAt = activeKey === "effect" ? costQuery.dataUpdatedAt
    : activeKey === "pricing" ? pricingQuery.dataUpdatedAt
    : decisionQuery.dataUpdatedAt;

  const handleChange = (key: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", key);
    setSearchParams(params, { replace: true });
  };

  return (
    <PageContainer title="推广中心" subTitle="自主决策、推广效果与调价历史" updatedAt={updatedAt}>
      <Tabs
        activeKey={activeKey}
        onChange={handleChange}
        items={[
          { key: "decision", label: "决策", children: <PromoDecision /> },
          { key: "effect", label: "效果", children: <PromoEffect /> },
          { key: "pricing", label: "调价历史", children: <PromoPricingHistory /> },
        ]}
      />
    </PageContainer>
  );
}
