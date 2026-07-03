// ============================================================
// Fallback Module — API → RPA channel switching
// Phase 1: Placeholder. Stores failed operations for manual retry.
// Phase 2: Integrates with Yingdao RPA for automatic fallback.
// ============================================================

import type { OzonDraftInput, OzonDraftResult } from "@onzo/shared-types";
import { CircuitBreakerOpenError } from "./errors.js";

export type FallbackAction = "create_draft" | "upload_image" | "update_price" | "update_stock";

export interface FailedOperation {
  id: string;
  action: FallbackAction;
  payload: unknown;
  error: string;
  timestamp: string;
  retryCount: number;
  maxRetries: number;
}

/**
 * Fallback handler — invoked when the primary API channel fails.
 * Phase 1: Log the failure and store for manual retry.
 * Phase 2: Route to RPA browser automation.
 */
export class FallbackHandler {
  private failedOps: FailedOperation[] = [];
  private rpaEndpoint: string | null = null;

  constructor(rpaEndpoint?: string) {
    this.rpaEndpoint = rpaEndpoint ?? null;
  }

  /**
   * Handle a failed API operation.
   * Returns null in Phase 1 (no RPA) — caller must use manual retry.
   * In Phase 2, returns the RPA result.
   */
  async handleFailure(
    action: FallbackAction,
    payload: unknown,
    error: Error
  ): Promise<OzonDraftResult | null> {
    const failed: FailedOperation = {
      id: crypto.randomUUID(),
      action,
      payload,
      error: error.message,
      timestamp: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    };

    this.failedOps.push(failed);

    // Phase 1: no RPA — log and return null
    if (!this.rpaEndpoint) {
      console.warn(`[Fallback] ${action} failed: ${error.message}. Queued for manual retry.`);
      return null;
    }

    // Phase 2: dispatch to RPA endpoint
    try {
      const resp = await fetch(this.rpaEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, payload }),
      });
      if (resp.ok) {
        return (await resp.json()) as OzonDraftResult;
      }
    } catch (rpaErr) {
      console.error(`[Fallback] RPA dispatch also failed: ${(rpaErr as Error).message}`);
    }

    return null;
  }

  /**
   * Check if the error should trigger a fallback attempt.
   */
  shouldFallback(error: Error): boolean {
    return (
      error instanceof CircuitBreakerOpenError ||
      (error.name === "RetryableError" &&
        "statusCode" in (error as Record<string, unknown>) &&
        (error as Record<string, unknown>).statusCode === 429)
    );
  }

  /** List pending failed operations for the manual retry dashboard. */
  getPendingOperations(): FailedOperation[] {
    return this.failedOps.filter((op) => op.retryCount < op.maxRetries);
  }

  /** Retry a previously failed operation via the primary API channel. */
  async retryOperation(
    opId: string,
    primaryFn: () => Promise<OzonDraftResult>
  ): Promise<OzonDraftResult | null> {
    const op = this.failedOps.find((o) => o.id === opId);
    if (!op || op.retryCount >= op.maxRetries) return null;

    try {
      const result = await primaryFn();
      // Remove from failed list on success
      this.failedOps = this.failedOps.filter((o) => o.id !== opId);
      return result;
    } catch (err) {
      op.retryCount++;
      return null;
    }
  }
}
