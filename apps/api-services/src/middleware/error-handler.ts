import type { Request, Response, NextFunction } from "express";
import { logger } from "@onzo/logger";
import { AppError } from "../errors/index.js";
import { writeToDeadLetter } from "../services/dead-letter.js";

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
  const correlationId = (req as Request & { correlationId?: string }).correlationId ?? "unknown";

  if (err instanceof AppError) {
    logger.warn({ correlationId, code: err.code, message: err.message }, "Application error");
    
    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
      },
      correlationId,
    };
    res.status(err.statusCode).json(response);
    return;
  }

  logger.error({ correlationId, err: { message: err.message, name: err.name, stack: err.stack } }, "Unhandled request error");

  // Write non-AppError failures to dead letter queue for retry
  if (!(err instanceof AppError)) {
    writeToDeadLetter({
      taskType: req.method + " " + req.path,
      errorMessage: err.message,
      correlationId,
    }).catch(() => {});
  }

  // Always use sanitized message in all deployed environments.
  // Raw error details go to logs only — never exposed to API consumers.
  const response: ApiErrorResponse = {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
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