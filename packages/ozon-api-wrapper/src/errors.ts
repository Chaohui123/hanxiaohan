// ============================================================
// Error hierarchy for Ozon API calls
// ============================================================

export class OzonApiError extends Error {
  public readonly statusCode: number;
  public readonly ozonCode?: string;
  public readonly isRetryable: boolean;
  public readonly headers?: Record<string, string>;

  constructor(
    message: string,
    statusCode: number,
    options: {
      ozonCode?: string;
      isRetryable?: boolean;
      headers?: Record<string, string>;
    } = {}
  ) {
    super(message);
    this.name = "OzonApiError";
    this.statusCode = statusCode;
    this.ozonCode = options.ozonCode;
    this.isRetryable = options.isRetryable ?? false;
    this.headers = options.headers;
  }
}

export class RetryableError extends OzonApiError {
  public readonly retryAfterMs?: number;

  constructor(
    message: string,
    statusCode: number,
    retryAfterMs?: number
  ) {
    super(message, statusCode, { isRetryable: true });
    this.name = "RetryableError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class RateLimitError extends RetryableError {
  constructor(
    message: string,
    retryAfterMs: number
  ) {
    super(message, 429, retryAfterMs);
    this.name = "RateLimitError";
  }
}

export class ServerError extends RetryableError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode);
    this.name = "ServerError";
  }
}

export class FatalError extends OzonApiError {
  constructor(
    message: string,
    statusCode: number,
    ozonCode?: string
  ) {
    super(message, statusCode, { isRetryable: false, ozonCode });
    this.name = "FatalError";
  }
}

export class ValidationError extends FatalError {
  constructor(message: string, ozonCode?: string) {
    super(message, 400, ozonCode);
    this.name = "ValidationError";
  }
}

export class AuthError extends FatalError {
  constructor(message: string, statusCode: 401 | 403) {
    super(message, statusCode);
    this.name = "AuthError";
  }
}

export class CircuitBreakerOpenError extends Error {
  public readonly openedAt: Date;
  public readonly remainingMs: number;

  constructor(openedAt: Date, remainingMs: number) {
    super(`Circuit breaker is OPEN. Retry available in ${Math.ceil(remainingMs / 1000)}s`);
    this.name = "CircuitBreakerOpenError";
    this.openedAt = openedAt;
    this.remainingMs = remainingMs;
  }
}

export class NetworkError extends RetryableError {
  constructor(message: string) {
    super(message, 0);
    this.name = "NetworkError";
  }
}
