import { z, type ZodTypeAny } from "zod";
import type { Request, Response, NextFunction } from "express";
import { ValidationError } from "../errors/index.js";

// ---- Zod-based validation (new) ----
export function validate<T extends ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errorMessage = result.error.issues.map(issue =>
        `${issue.path.join(".")}: ${issue.message}`
      ).join(", ");

      throw new ValidationError(errorMessage);
    }

    (req as Request & { validatedBody: z.infer<T> }).validatedBody = result.data;
    next();
  };
}

// ---- Legacy field-rule validation (backward compat) ----
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
          body[rule.field] = Number(value);
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

// ---- Zod schemas (for use with validate()) ----
export const CreateTaskSchema = z.object({
  type: z.enum(["listing", "ocr", "translate", "upload_image", "create_draft", "batch_listing"]),
  payload: z.record(z.string(), z.any()).optional(),
  storeId: z.string().optional().default("store_1"),
  priority: z.number().int().min(0).max(10).optional().default(0),
  maxRetries: z.number().int().min(1).max(10).optional().default(3),
});

export const ProcessListingSchema = z.object({
  sourceUrl: z.string().url(),
  storeId: z.string().optional().default("store_1"),
});

export const BulkUploadSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(100),
  storeId: z.string().optional().default("store_1"),
  skipOcr: z.boolean().optional().default(false),
});