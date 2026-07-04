// ============================================================
// Request body validation middleware — lightweight JSON Schema
// No external library; validates required fields + types inline
// ============================================================

import type { Request, Response, NextFunction } from "express";

interface FieldRule {
  field: string;
  type: "string" | "number" | "array" | "boolean";
  required?: boolean;
  min?: number;
  max?: number;
}

export function validateBody(rules: FieldRule[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as Record<string, unknown>;
    const errors: string[] = [];

    for (const rule of rules) {
      const value = body[rule.field];

      if (rule.required && (value === undefined || value === null || value === "")) {
        errors.push(`${rule.field} is required`);
        continue;
      }

      if (value === undefined || value === null) continue;

      if (rule.type === "number" && typeof value !== "number") {
        if (typeof value === "string" && !isNaN(Number(value))) {
          body[rule.field] = Number(value); // coerce
        } else {
          errors.push(`${rule.field} must be a number`);
        }
      }

      if (rule.type === "array" && !Array.isArray(value)) {
        errors.push(`${rule.field} must be an array`);
      }

      if (rule.type === "string" && typeof value !== "string") {
        errors.push(`${rule.field} must be a string`);
      }

      if (rule.min !== undefined && (typeof value === "string" || Array.isArray(value))) {
        if (value.length < rule.min) errors.push(`${rule.field} minimum ${rule.min} required`);
      }

      if (rule.max !== undefined && (typeof value === "string" || Array.isArray(value))) {
        if (value.length > rule.max) errors.push(`${rule.field} maximum ${rule.max} allowed`);
      }
    }

    if (errors.length > 0) {
      res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: errors.join("; "), retryable: false },
        details: errors,
        correlationId: req.correlationId,
      });
      return;
    }

    next();
  };
}
