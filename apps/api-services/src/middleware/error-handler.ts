// ============================================================
// Unified error handler middleware
// ============================================================

import type { Request, Response, NextFunction } from "express";

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
  correlationId: string;
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const correlationId = req.correlationId ?? "unknown";

  console.error(`[${correlationId}] Unhandled error:`, err);

  const response: ApiErrorResponse = {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: err.message || "An unexpected error occurred",
      retryable: determineRetryable(err),
    },
    correlationId,
  };

  const statusCode = getStatusCode(err);
  res.status(statusCode).json(response);
}

function determineRetryable(err: Error): boolean {
  const retryableNames = [
    "RetryableError",
    "RateLimitError",
    "ServerError",
    "NetworkError",
    "CircuitBreakerOpenError",
  ];
  return retryableNames.includes(err.name);
}

function getStatusCode(err: Error): number {
  const errWithCode = err as { statusCode?: unknown };
  if ("statusCode" in err && typeof errWithCode.statusCode === "number") {
    return errWithCode.statusCode;
  }
  return 500;
}
