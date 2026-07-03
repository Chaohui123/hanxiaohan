// ============================================================
// Request/Response Validator for Ozon API Wrapper
// Pre-validates API call parameters before sending requests.
// Catches malformed responses before they propagate upstream.
// ============================================================

import type { OzonDraftInput } from "@onzo/shared-types";

export interface ValidationIssue {
  field: string;
  message: string;
}

/**
 * Validate Ozon draft input before API call.
 * Returns list of issues — empty array means valid.
 */
export function validateDraftInput(input: OzonDraftInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!input.name || input.name.trim().length < 10) {
    issues.push({ field: "name", message: "Title must be at least 10 characters" });
  }
  if (input.name && input.name.length > 2000) {
    issues.push({ field: "name", message: "Title must be under 2000 characters" });
  }
  if (!input.description || input.description.trim().length === 0) {
    issues.push({ field: "description", message: "Description is required" });
  }
  if (!input.categoryId || input.categoryId <= 0) {
    issues.push({ field: "categoryId", message: "Valid category ID is required" });
  }
  if (typeof input.price !== "number" || input.price <= 0) {
    issues.push({ field: "price", message: "Price must be > 0" });
  }
  if (!["0", "0.1", "0.2"].includes(input.vat)) {
    issues.push({ field: "vat", message: 'VAT must be "0", "0.1", or "0.2"' });
  }
  if (!input.images || input.images.length === 0) {
    issues.push({ field: "images", message: "At least 1 image ID is required" });
  }
  if (input.images && input.images.length > 15) {
    issues.push({ field: "images", message: "Maximum 15 images allowed" });
  }
  if (!input.dimensions || input.dimensions.length <= 0 || input.dimensions.width <= 0 || input.dimensions.height <= 0) {
    issues.push({ field: "dimensions", message: "Length, width, height must be > 0" });
  }
  if (!input.dimensions || input.dimensions.weight <= 0) {
    issues.push({ field: "dimensions.weight", message: "Weight must be > 0" });
  }

  return issues;
}

/**
 * Validate API response shape (runtime check after JSON parse).
 */
export function validateApiResponse<T>(
  data: unknown,
  requiredFields: (keyof T)[]
): data is T {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return requiredFields.every((f) => f as string in obj);
}
