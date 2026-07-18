// ============================================================
// Ops-Agent LangGraph Nodes
// Wraps existing ops-agent APIs, no internal logic rewrite
// ============================================================

import type { ProductLaunchState } from "../state-v2.js";
import { logger } from "@onzo/logger";

const API_KEY = process.env.API_KEY || "";
const API_BASE = process.env.API_BASE_URL || "http://localhost:3000";

async function apiCall(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 300);
    throw new Error(`Ops API ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<Record<string, unknown>>;
}

// ---- Node 1: Product Analysis (DeepSeek RAG) ----

export async function opsAnalysisNode(
  state: typeof ProductLaunchState.State,
): Promise<Partial<typeof ProductLaunchState.State>> {
  const t0 = Date.now();
  logger.info({ taskId: state.taskId }, "Ops: analyzing product");

  try {
    // Use existing RAG chat endpoint for product analysis
    const resp = await apiCall("/api/rag/chat", "POST", {
      query: `分析这个1688商品是否适合在Ozon俄罗斯销售：${state.sourceUrl}。评估利润、合规、需求。`,
      postingNumber: "",
    });
    const data = resp.data as { answer?: string } | undefined;
    const answer = data?.answer || "Analysis unavailable";

    return {
      analysisResult: answer,
      agentLog: [{ agent: "ops", node: "analysis", success: true, durationMs: Date.now() - t0 }],
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ taskId: state.taskId, err: msg }, "Ops analysis failed");

    return {
      analysisError: msg,
      analysisResult: "Analysis skipped — LLM unavailable",
      agentLog: [{ agent: "ops", node: "analysis", success: false, error: msg, durationMs: Date.now() - t0 }],
      alerts: [{ level: "warn", event: "ANALYSIS_FAILED", message: `选品分析失败: ${msg}` }],
    };
  }
}

// ---- Node 2: Submit Listing to Ozon ----

export async function opsListingNode(
  state: typeof ProductLaunchState.State,
): Promise<Partial<typeof ProductLaunchState.State>> {
  const t0 = Date.now();
  logger.info({ taskId: state.taskId, url: state.sourceUrl }, "Ops: submitting listing");

  try {
    const resp = await apiCall("/api/process", "POST", {
      url: state.sourceUrl,
      storeId: state.storeId || "store_1",
    });
    const data = resp.data as { taskId?: string; draftId?: string; ozonProductId?: number } | undefined;

    const listing: ListingResult = {
      productId: (data?.ozonProductId as number) || 0,
      offerId: (data?.draftId as string) || (data?.taskId as string) || "",
      status: "submitted",
    };

    return {
      listing,
      agentLog: [{ agent: "ops", node: "listing", success: true, durationMs: Date.now() - t0 }],
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ taskId: state.taskId, err: msg }, "Ops listing failed");

    return {
      listingError: msg,
      listing: { productId: 0, offerId: "", status: "failed" },
      agentLog: [{ agent: "ops", node: "listing", success: false, error: msg, durationMs: Date.now() - t0 }],
      alerts: [{ level: "error", event: "LISTING_FAILED", message: `上架失败: ${msg}` }],
    };
  }
}

// ---- Node 3: Sync Orders ----

export async function opsOrderSyncNode(
  state: typeof ProductLaunchState.State,
): Promise<Partial<typeof ProductLaunchState.State>> {
  const t0 = Date.now();
  logger.info({ taskId: state.taskId }, "Ops: syncing orders");

  try {
    await apiCall("/api/orders/sync", "POST", { storeId: state.storeId || "store_1" });

    // Fetch order summary
    const resp = await apiCall("/api/orders?days=7", "GET");
    const orders = (resp.data as Array<Record<string, unknown>>) || [];
    const summary: OrderSummary = {
      totalOrders: orders.length,
      totalRevenueRub: orders.reduce((s: number, o: Record<string, unknown>) => s + (Number(o.total_price_rub) || 0), 0),
      totalCommissionRub: orders.reduce((s: number, o: Record<string, unknown>) => s + (Number(o.commission_rub) || 0), 0),
      totalPayoutRub: orders.reduce((s: number, o: Record<string, unknown>) => s + (Number(o.payout_rub) || 0), 0),
    };

    return {
      orders: summary,
      agentLog: [{ agent: "ops", node: "orders", success: true, durationMs: Date.now() - t0 }],
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ taskId: state.taskId, err: msg }, "Ops order sync failed");

    return {
      ordersError: msg,
      orders: { totalOrders: 0, totalRevenueRub: 0, totalCommissionRub: 0, totalPayoutRub: 0 },
      agentLog: [{ agent: "ops", node: "orders", success: false, error: msg, durationMs: Date.now() - t0 }],
      alerts: [{ level: "error", event: "ORDER_SYNC_FAILED", message: `订单同步失败: ${msg}` }],
    };
  }
}

// Re-export types used in the node
import type { ListingResult, OrderSummary } from "../state-v2.js";
