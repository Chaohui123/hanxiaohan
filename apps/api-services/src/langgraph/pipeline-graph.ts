// ============================================================
// LangGraph Full Pipeline — Product Launch → Profit (v2)
// Ops-Agent ↔ Promo-Agent orchestrated
//
// Flow:
//   START → opsAnalysis → [profitable?]
//     ├─ loss → sendAlert → END
//     └─ ok → opsListing → promoCreateAd → opsOrderSync → profitCalc
//               └─ [promo profitable?]
//                    ├─ ok → sendSuccessReport → END
//                    └─ loss → promoPauseAds → sendLossAlert → END
// ============================================================

import { StateGraph, END } from "@langchain/langgraph";
import { ProductLaunchState } from "./state-v2.js";
import { opsAnalysisNode, opsListingNode, opsOrderSyncNode } from "./nodes/ops-nodes.js";
import { promoCreateAdNode, promoPauseAdsNode } from "./nodes/promo-nodes.js";
import { logger } from "@onzo/logger";
import { deepseekComplete } from "./client/deepseek-client.js";

// ---- Profit calculation node ----

async function profitCalcNode(
  state: typeof ProductLaunchState.State,
): Promise<Partial<typeof ProductLaunchState.State>> {
  logger.info({ taskId: state.taskId }, "Pipeline: calculating full profit");

  try {
    const orders = state.orders;
    if (!orders || orders.totalOrders === 0) {
      return { fullProfit: null, profitError: "No orders to calculate" };
    }

    const adSpendRub = 500; // default daily budget
    const estimatedCostCny = 100; // rough estimate
    const netProfitRub = orders.totalPayoutRub - adSpendRub - (estimatedCostCny * 11.5);
    const margin = orders.totalRevenueRub > 0 ? (netProfitRub / orders.totalRevenueRub) * 100 : 0;

    return {
      fullProfit: {
        costCny: estimatedCostCny,
        revenueRub: orders.totalRevenueRub,
        adSpendRub,
        netProfitRub: Math.round(netProfitRub * 100) / 100,
        marginPercent: Math.round(margin * 100) / 100,
        isProfitable: netProfitRub > 0,
      },
    };
  } catch (err) {
    return { profitError: (err as Error).message };
  }
}

// ---- Alert dispatch node ----

async function sendAlertNode(
  state: typeof ProductLaunchState.State,
): Promise<Partial<typeof ProductLaunchState.State>> {
  const alerts = state.alerts || [];
  const totalAlerts = alerts.length;

  try {
    const { notifier } = await import("../services/notifier.js");
    for (const alert of alerts) {
      await notifier.notify({
        level: (alert.level as "info" | "warn" | "error" | "critical") || "info",
        event: alert.event,
        message: alert.message,
        correlationId: `pipeline-${state.taskId}`,
        force: alert.level === "error",
      }).catch(() => {});
    }
  } catch { /* notifier unavailable */ }

  if (totalAlerts > 0) {
    logger.info({ taskId: state.taskId, alertCount: totalAlerts }, "Pipeline: alerts dispatched");
  }
  return {};
}

// ---- Condition functions ----

function isProfitableForListing(
  state: typeof ProductLaunchState.State,
): "ops_listing" | "send_alert" {
  // If analysis failed but we have a URL, try listing anyway
  if (state.analysisError && !state.analysisResult) {
    return "ops_listing"; // fail-open: let listing proceed
  }
  // If analysis result contains "不推荐" or "亏损", skip
  if (state.analysisResult?.includes("不推荐") || state.analysisResult?.includes("亏损")) {
    return "send_alert";
  }
  return "ops_listing";
}

function isPromoProfitable(
  state: typeof ProductLaunchState.State,
): "send_alert" | "promo_pause" {
  if (state.fullProfit?.isProfitable) return "send_alert"; // success report
  return "promo_pause"; // loss → pause ads
}

// ---- Build graph ----

function buildFullPipelineGraph() {
  const graph = new StateGraph(ProductLaunchState)
    .addNode("ops_analysis", opsAnalysisNode)
    .addNode("ops_listing", opsListingNode)
    .addNode("promo_ads", promoCreateAdNode)
    .addNode("ops_orders", opsOrderSyncNode)
    .addNode("profit_calc", profitCalcNode)
    .addNode("promo_pause", promoPauseAdsNode)
    .addNode("send_alert", sendAlertNode)

    .addEdge("__start__", "ops_analysis")

    // Analysis → listing or alert
    .addConditionalEdges("ops_analysis", isProfitableForListing, {
      ops_listing: "ops_listing",
      send_alert: "send_alert",
    })

    .addEdge("ops_listing", "promo_ads")
    .addEdge("promo_ads", "ops_orders")
    .addEdge("ops_orders", "profit_calc")

    // Profit → success or pause
    .addConditionalEdges("profit_calc", isPromoProfitable, {
      send_alert: "send_alert",
      promo_pause: "promo_pause",
    })

    .addEdge("promo_pause", "send_alert")
    .addEdge("send_alert", END)

    .compile();

  return graph;
}

let _pipelineGraph: ReturnType<typeof buildFullPipelineGraph> | null = null;

export function getFullPipelineGraph() {
  if (!_pipelineGraph) _pipelineGraph = buildFullPipelineGraph();
  return _pipelineGraph;
}

// ---- Execute ----

export async function executeFullPipeline(input: {
  sourceUrl: string;
  storeId?: string;
}): Promise<typeof ProductLaunchState.State> {
  const taskId = `launch_${Date.now()}`;
  logger.info({ taskId, url: input.sourceUrl }, "Pipeline: full launch workflow started");

  const graph = getFullPipelineGraph();
  const result = await graph.invoke({
    sourceUrl: input.sourceUrl,
    storeId: input.storeId || "store_1",
    taskId,
    analysisResult: "",
    analysisError: "",
    listing: null,
    listingError: "",
    promo: null,
    promoError: "",
    orders: null,
    ordersError: "",
    fullProfit: null,
    profitError: "",
    agentLog: [],
    alerts: [],
  });

  // Generate final summary via DeepSeek
  if (result.fullProfit) {
    try {
      const summary = await deepseekComplete(
        "你是Ozon运营助手，用中文简洁汇报。",
        `商品: ${input.sourceUrl}\n利润: ${result.fullProfit.netProfitRub}卢布\n利润率: ${result.fullProfit.marginPercent}%\n订单数: ${result.orders?.totalOrders || 0}\n用一句话总结推广效果。`,
      );
      logger.info({ taskId, summary }, "Pipeline: DeepSeek summary");
    } catch { /* LLM summary is optional */ }
  }

  logger.info({
    taskId,
    listingOk: !!result.listing?.productId,
    promoOk: !!result.promo?.planId,
    orders: result.orders?.totalOrders,
    profit: result.fullProfit?.netProfitRub,
  }, "Pipeline: full launch workflow complete");

  return result;
}
