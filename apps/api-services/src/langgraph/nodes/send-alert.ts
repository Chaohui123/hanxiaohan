import { ProcurementState } from "../state.js";
// ============================================================
// Node 6: Alert Dispatch — TG notifications for profit/loss/errors
// ============================================================

import type { AlertPayload } from "../state.js";
type StateType = typeof ProcurementState.State;
import { logger } from "@onzo/logger";

export async function sendProfitAlertNode(
  state: StateType,
): Promise<Partial<StateType>> {
  const alerts: AlertPayload[] = [...(state.alerts || [])];
  const order = state.ozonOrder;
  const profit = state.profit;
  const postingNumber = order?.postingNumber || state.postingNumber;

  // Profit alert
  if (profit && order) {
    if (profit.isProfitable) {
      alerts.push({
        level: "info",
        event: "PROCUREMENT_PROFITABLE",
        message: `订单 ${postingNumber} 盈利 ¥${profit.netProfitRub} (${profit.marginPercent}%)`,
        postingNumber,
        detail: {
          totalCostCny: String(profit.totalCostCny),
          netProfitRub: String(profit.netProfitRub),
          margin: String(profit.marginPercent),
        },
      });
    } else {
      alerts.push({
        level: "warn",
        event: "PROCUREMENT_LOSS",
        message: `⚠️ 订单 ${postingNumber} 亏损 ¥${Math.abs(profit.netProfitRub)} (${profit.marginPercent}%)，终止采购`,
        postingNumber,
        detail: {
          totalCostCny: String(profit.totalCostCny),
          netProfitRub: String(profit.netProfitRub),
          margin: String(profit.marginPercent),
        },
      });
    }
  }

  // Error alerts
  if (state.orderSyncError) {
    alerts.push({
      level: "error",
      event: "ORDER_SYNC_FAILED",
      message: `订单同步失败: ${state.orderSyncError}`,
      postingNumber,
      detail: { error: state.orderSyncError },
    });
  }

  if (state.profitError) {
    alerts.push({
      level: "error",
      event: "PROFIT_CALC_FAILED",
      message: `利润计算失败: ${state.profitError}`,
      postingNumber,
      detail: { error: state.profitError },
    });
  }

  // Purchase success/failure
  if (state.purchaseId) {
    alerts.push({
      level: "info",
      event: "PURCHASE_CREATED",
      message: `采购单 ${state.purchaseId} 已创建 (${postingNumber})`,
      postingNumber,
      detail: { purchaseId: state.purchaseId },
    });
  } else if (state.purchaseError && !state.purchaseError.includes("not profitable") && !state.purchaseError.includes("not enabled")) {
    alerts.push({
      level: "error",
      event: "PURCHASE_FAILED",
      message: `采购创建失败: ${state.purchaseError}`,
      postingNumber,
      detail: { error: state.purchaseError },
    });
  }

  // Dispatch all alerts via notifier
  if (alerts.length > 0) {
    try {
      const { notifier } = await import("../../services/notifier.js");
      for (const alert of alerts) {
        await notifier.notify({
          level: alert.level,
          event: alert.event,
          message: alert.message,
          correlationId: `langgraph-${postingNumber}-${Date.now()}`,
          force: alert.level === "error" || alert.level === "critical",
          metadata: alert.detail,
        }).catch(() => { /* alert delivery is best-effort */ });
      }
      logger.info({ alertCount: alerts.length }, "LangGraph: alerts dispatched");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "LangGraph: alert dispatch failed (notifier unavailable)");
    }
  }

  return { alerts };
}

/** Global error alert node — catches workflow-level failures */
export async function globalErrorAlertNode(
  state: StateType,
): Promise<Partial<StateType>> {
  const alerts: AlertPayload[] = [...(state.alerts || [])];
  const allErrors = [
    state.orderSyncError,
    state.matchError,
    state.profitError,
    state.ragError,
    state.purchaseError,
  ].filter(Boolean);

  if (allErrors.length > 0) {
    alerts.push({
      level: "critical",
      event: "WORKFLOW_ERROR",
      message: `LangGraph 工作流异常: ${allErrors.join("; ")}`,
      postingNumber: state.postingNumber,
      detail: { errors: allErrors.join(" | ") },
    });
  }

  // Best-effort TG notify
  try {
    const { notifier } = await import("../../services/notifier.js");
    for (const alert of alerts.filter(a => a.level === "critical")) {
      await notifier.notify({
        level: "critical",
        event: alert.event,
        message: alert.message,
        correlationId: `langgraph-fatal-${Date.now()}`,
        force: true,
        metadata: alert.detail,
      }).catch(() => {});
    }
  } catch { /* notifier unavailable */ }

  return { alerts };
}
