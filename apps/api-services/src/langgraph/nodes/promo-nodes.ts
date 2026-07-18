// ============================================================
// Promo-Agent LangGraph Nodes
// Wraps existing promo-agent APIs, no internal logic rewrite
// ============================================================

import type { ProductLaunchState } from "../state-v2.js";
import { logger } from "@onzo/logger";

const API_KEY = process.env.API_KEY || "";
const PROMO_API = process.env.PROMO_AGENT_API || "http://promo-agent:8182";
const API_BASE = process.env.API_BASE_URL || "http://localhost:3000";

async function apiCall(base: string, path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 300);
    throw new Error(`Promo API ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<Record<string, unknown>>;
}

// ---- Node 4: Create Ad Campaign ----

export async function promoCreateAdNode(
  state: typeof ProductLaunchState.State,
): Promise<Partial<typeof ProductLaunchState.State>> {
  const t0 = Date.now();
  const offerId = state.listing?.offerId || "";

  if (!offerId) {
    return {
      promoError: "No listing to promote — skip ad creation",
      promo: null,
      agentLog: [{ agent: "promo", node: "ads", success: false, error: "No offerId", durationMs: 0 }],
    };
  }

  logger.info({ taskId: state.taskId, offerId }, "Promo: creating ad campaign");

  try {
    const planId = `promo_${state.taskId}_${Date.now()}`;
    const resp = await apiCall(API_BASE, "/api/promo/decision", "POST", {
      id: planId,
      actions: [{
        offerId,
        type: "launch_ad",
        suggestedPrice: state.listing?.productId ? undefined : undefined,
      }],
      source: "langgraph_launch_workflow",
    });

    const promo: PromoResult = {
      planId,
      status: (resp.success as boolean) ? "active" : "pending",
      actions: [{ offerId, type: "launch_ad" }],
      dailyBudget: 500,
    };

    return {
      promo,
      agentLog: [{ agent: "promo", node: "ads", success: true, durationMs: Date.now() - t0 }],
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ taskId: state.taskId, err: msg }, "Promo ad creation failed");

    return {
      promoError: msg,
      promo: null,
      agentLog: [{ agent: "promo", node: "ads", success: false, error: msg, durationMs: Date.now() - t0 }],
      alerts: [{ level: "error", event: "PROMO_FAILED", message: `推广创建失败: ${msg}` }],
    };
  }
}

// ---- Node: Pause Ads (on loss) ----

export async function promoPauseAdsNode(
  state: typeof ProductLaunchState.State,
): Promise<Partial<typeof ProductLaunchState.State>> {
  const promoId = state.promo?.planId;
  if (!promoId) return {};

  logger.warn({ taskId: state.taskId, promoId }, "Promo: pausing ads — campaign unprofitable");

  try {
    await apiCall(API_BASE, "/api/promo/decision", "POST", {
      id: promoId,
      actions: [{ offerId: state.listing?.offerId || "", type: "pause" }],
    });
    return {
      alerts: [...(state.alerts || []), { level: "warn", event: "PROMO_PAUSED", message: `推广已暂停: ${promoId}` }],
    };
  } catch (err) {
    return {
      alerts: [...(state.alerts || []), { level: "error", event: "PROMO_PAUSE_FAILED", message: `暂停推广失败: ${(err as Error).message}` }],
    };
  }
}

import type { PromoResult } from "../state-v2.js";
