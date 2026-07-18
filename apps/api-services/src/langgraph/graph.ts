// ============================================================
// LangGraph StateGraph — Ozon Procurement Workflow (v1)
//
// Flow: START → sync_order → match_sources → calculate_profit
//                          ├─ profitable → create_purchase → send_alert → END
//                          └─ loss → send_alert → END
// ============================================================

import { StateGraph, END } from "@langchain/langgraph";
import { ProcurementState } from "./state.js";
import { syncOrderNode } from "./nodes/sync-orders.js";
import { matchSourcesNode } from "./nodes/match-sources.js";
import { calculateProfitNode } from "./nodes/calculate-profit.js";
import { createPurchaseNode } from "./nodes/create-purchase.js";
import { sendProfitAlertNode, globalErrorAlertNode } from "./nodes/send-alert.js";
import { ragQaNode } from "./nodes/rag-qa.js";
import { logger } from "@onzo/logger";

// ---- Condition: profit branch ----

function isProfitable(
  state: typeof ProcurementState.State,
): "create_purchase" | "send_alert" {
  if (state.profit?.isProfitable) return "create_purchase";
  return "send_alert";
}

// ---- Build procurement graph ----

function buildProcurementGraph() {
  const graph = new StateGraph(ProcurementState)
    .addNode("sync_order", syncOrderNode)
    .addNode("match_sources", matchSourcesNode)
    .addNode("calculate_profit", calculateProfitNode)
    .addNode("create_purchase", createPurchaseNode)
    .addNode("send_alert", sendProfitAlertNode)

    .addEdge("__start__", "sync_order")
    .addEdge("sync_order", "match_sources")
    .addEdge("match_sources", "calculate_profit")

    .addConditionalEdges("calculate_profit", isProfitable, {
      create_purchase: "create_purchase",
      send_alert: "send_alert",
    })

    .addEdge("create_purchase", "send_alert")
    .addEdge("send_alert", END)

    .compile();

  return graph;
}

// ---- Build RAG graph ----

function buildRagGraph() {
  const graph = new StateGraph(ProcurementState)
    .addNode("sync_order", syncOrderNode)
    .addNode("match_sources", matchSourcesNode)
    .addNode("rag_qa", ragQaNode)
    .addNode("send_alert", sendProfitAlertNode)

    .addEdge("__start__", "sync_order")
    .addEdge("sync_order", "match_sources")
    .addEdge("match_sources", "rag_qa")
    .addEdge("rag_qa", "send_alert")
    .addEdge("send_alert", END)

    .compile();

  return graph;
}

// ---- Exports ----

let _procurementGraph: ReturnType<typeof buildProcurementGraph> | null = null;
let _ragGraph: ReturnType<typeof buildRagGraph> | null = null;

export function getProcurementGraph() {
  if (!_procurementGraph) _procurementGraph = buildProcurementGraph();
  return _procurementGraph;
}

export function getRagGraph() {
  if (!_ragGraph) _ragGraph = buildRagGraph();
  return _ragGraph;
}

// ---- Execute procurement workflow ----

export async function executeProcurementWorkflow(input: {
  postingNumber: string;
  storeId?: string;
}): Promise<typeof ProcurementState.State> {
  logger.info({ postingNumber: input.postingNumber }, "LangGraph: executing procurement workflow");

  const graph = getProcurementGraph();
  const result = await graph.invoke({
    storeId: input.storeId || "store_1",
    postingNumber: input.postingNumber,
    ragQuery: "",
    ozonOrder: null,
    orderSyncError: "",
    sourceMatches: [],
    matchError: "",
    profit: null,
    profitError: "",
    ragResult: null,
    ragError: "",
    purchaseId: "",
    purchaseError: "",
    alerts: [],
  });

  // Non-blocking error alert
  if (result.orderSyncError || result.profitError || result.purchaseError) {
    globalErrorAlertNode(result).catch(() => {});
  }

  logger.info({
    postingNumber: input.postingNumber,
    purchaseId: result.purchaseId || "(none)",
    profitable: result.profit?.isProfitable,
  }, "LangGraph: procurement workflow complete");

  return result;
}

// ---- Execute RAG workflow ----

export async function executeRagWorkflow(input: {
  postingNumber?: string;
  query: string;
  storeId?: string;
}): Promise<typeof ProcurementState.State> {
  logger.info({ query: input.query.slice(0, 80) }, "LangGraph: executing RAG workflow");

  const graph = getRagGraph();
  const result = await graph.invoke({
    storeId: input.storeId || "store_1",
    postingNumber: input.postingNumber || "",
    ragQuery: input.query,
    ozonOrder: null,
    orderSyncError: "",
    sourceMatches: [],
    matchError: "",
    profit: null,
    profitError: "",
    ragResult: null,
    ragError: "",
    purchaseId: "",
    purchaseError: "",
    alerts: [],
  });

  return result;
}
