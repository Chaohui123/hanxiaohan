// ============================================================
// PII Sanitizer — strip sensitive fields from objects before logging.
// GDPA-compliant: masks Russian/Chinese PII in log output.
// ============================================================

/** Field name patterns that indicate PII — matched case-insensitive. */
const PII_FIELD_PATTERNS = [
  /^(buyer_)?name$/i,
  /^(buyer_)?phone$/i,
  /^(buyer_)?email$/i,
  /^(buyer_)?address$/i,
  /^phone_number$/i,
  /^email$/i,
  /^password$/i,
  /^secret$/i,
  /^token$/i,
  /^api[_-]?key$/i,
  /^authorization$/i,
  /^credit[_-]?card$/i,
  /^passport$/i,
  /^inn$/i,             // Russian tax ID
  /^snils$/i,           // Russian pension ID
  /^personal_account$/i,
  /^full_name$/i,
  /^contact$/i,
  /^tracking_number$/i, // Can be linked to individual's package
  /^posting_number$/i,  // Ozon posting number (order ID)
];

const MASK = "***REDACTED***";

function isPiiField(key: string): boolean {
  return PII_FIELD_PATTERNS.some((p) => p.test(key));
}

/**
 * Recursively sanitize an object, replacing PII values with a redacted marker.
 * Returns a new object — does not mutate the original.
 */
export function sanitizeForLog(obj: unknown, maxDepth = 5): unknown {
  if (maxDepth <= 0) return "[max depth]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return sanitizeString(obj);
  if (typeof obj === "number" || typeof obj === "boolean") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeForLog(item, maxDepth - 1));
  }

  if (typeof obj === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isPiiField(key)) {
        sanitized[key] = MASK;
      } else {
        sanitized[key] = sanitizeForLog(value, maxDepth - 1);
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Sanitize a string that might contain embedded PII like phone numbers or emails.
 */
function sanitizeString(str: string): string {
  let result = str;
  // Phone numbers: various formats
  result = result.replace(/\+\d{1,3}[\d\s\-()]{6,18}/g, MASK);
  // Emails
  result = result.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, MASK);
  return result;
}

/**
 * Quick wrapper: sanitize and return as JSON-safe object.
 * Use before passing data to logger.info/logger.error.
 */
export function safeLogData(data: Record<string, unknown>): Record<string, unknown> {
  return sanitizeForLog(data) as Record<string, unknown>;
}
