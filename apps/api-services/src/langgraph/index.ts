// ============================================================
// LangGraph Module — Public API
// ============================================================

export { ProcurementState } from "./state.js";
export type {
  OzonOrder,
  OrderProduct,
  SourceMatch,
  ProfitResult,
  RagResult,
  AlertPayload,
} from "./state.js";

export { deepseekChatCompletion, deepseekComplete, deepseekHealthCheck, DeepSeekApiError } from "./client/deepseek-client.js";
export type { DeepSeekMessage, DeepSeekResponse } from "./client/deepseek-client.js";

export {
  getProcurementGraph,
  getRagGraph,
  executeProcurementWorkflow,
  executeRagWorkflow,
} from "./graph.js";

export { syncOrderNode } from "./nodes/sync-orders.js";
export { matchSourcesNode } from "./nodes/match-sources.js";
export { calculateProfitNode } from "./nodes/calculate-profit.js";
export { createPurchaseNode } from "./nodes/create-purchase.js";
export { sendProfitAlertNode, globalErrorAlertNode } from "./nodes/send-alert.js";
export { ragQaNode } from "./nodes/rag-qa.js";
