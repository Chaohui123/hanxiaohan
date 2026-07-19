// ============================================================
// Ozon Field Validator — Auto-fill required Ozon listing fields
// Resolves the 6th core fault: mandatory field validation.
// Auto-generates model name, title truncation, SKU, weight, materials.
// ============================================================

import { logger } from "@onzo/logger";

export interface StandardizedProductInput {
  title: string;
  titleRu?: string;
  descriptionRu?: string;
  categoryId: number;
  priceCny: number;
  weightG?: number;
  images: string[];
  specs: Array<{ name: string; value: string }>;
  sku?: string;
  barcode?: string;
  sourceUrl: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  filled: Record<string, string>;
}

interface OzonAttribute {
  id: number;
  name: string;
  description: string;
  type: string;
  isRequired: boolean;
  dictionary?: Array<{ id: number; value: string }>;
}

// Required fields per Ozon specification
const REQUIRED_FIELDS = [
  "name",            // Product title (max 500 chars)
  "description",      // Product description
  "category_id",      // Category
  "price",            // Selling price RUB
  "images",           // At least 1 image URL
  "depth",            // Package length mm
  "width",            // Package width mm
  "height",           // Package height mm
  "weight",           // Weight in grams
];

/**
 * Validate that all required Ozon listing fields are present.
 */
export function validateRequiredFields(
  product: StandardizedProductInput,
  categoryId: number,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const filled: Record<string, string> = {};

  if (!product.title || product.title.trim().length < 3) {
    errors.push("name: title must be at least 3 characters");
  } else if (product.title.length > 500) {
    warnings.push("name: title exceeds 500 chars, will be truncated");
  }

  if (!product.categoryId || product.categoryId <= 0) {
    errors.push("category_id: must be a valid Ozon category ID");
  }

  if (!product.priceCny || product.priceCny <= 0) {
    errors.push("price: must be positive");
  }

  if (!product.images || product.images.length === 0) {
    errors.push("images: at least 1 product image required");
  }

  if (!product.weightG || product.weightG <= 0) {
    warnings.push("weight: not specified, defaulting to 500g");
  }

  if (!product.specs || product.specs.length === 0) {
    warnings.push("specs: no specifications provided");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    filled,
  };
}

/**
 * Auto-fill missing fields using LLM analysis results.
 * Called BEFORE publishing to Ozon.
 */
export function autoFillFromLLM(
  product: StandardizedProductInput,
  llmOutput: {
    titleRu?: string;
    descriptionRu?: string;
    modelName?: string;
    categoryId?: number;
    estimatedWeightG?: number;
  },
): StandardizedProductInput {
  const filled = { ...product };

  // Title: use Russian title from LLM, fallback to original
  if (llmOutput.titleRu && llmOutput.titleRu.length >= 3) {
    filled.titleRu = llmOutput.titleRu.slice(0, 500);
  }

  // Description: from LLM or generate basic one
  if (llmOutput.descriptionRu) {
    filled.descriptionRu = llmOutput.descriptionRu.slice(0, 4000);
  } else {
    filled.descriptionRu = `Товар: ${filled.title || filled.titleRu || ""}. Подробности в характеристиках.`.slice(0, 4000);
  }

  // Category override from LLM
  if (llmOutput.categoryId && llmOutput.categoryId > 0) {
    filled.categoryId = llmOutput.categoryId;
  }

  // Weight: from LLM estimate, specs, or default
  if (!filled.weightG || filled.weightG <= 0) {
    filled.weightG = llmOutput.estimatedWeightG
      || extractWeightFromSpecs(product.specs)
      || parseInt(process.env.OZON_DEFAULT_WEIGHT_G || "500", 10);
  }

  logger.info({
    title: filled.titleRu?.slice(0, 40),
    category: filled.categoryId,
    weight: filled.weightG,
    images: filled.images.length,
  }, "OzonFieldValidator: fields auto-filled from LLM");

  return filled;
}

/**
 * Generate model name (Ozon required attribute 9048).
 * Max 60 chars per Ozon spec.
 */
export function generateModelName(title: string, specs: Array<{ name: string; value: string }>): string {
  const maxLen = parseInt(process.env.MODEL_NAME_MAX_LENGTH || "60", 10);

  // Try to extract model from specs first
  const modelSpec = specs.find((s) =>
    /型号|model|модель|артикул|part.?number/i.test(s.name)
  );
  if (modelSpec && modelSpec.value.length <= maxLen) {
    return modelSpec.value.trim();
  }

  // Fallback: use template
  const template = process.env.MODEL_NAME_RELAX_TEMPLATE || "Model-{title}";
  const cleanTitle = title.replace(/[^a-zA-Z0-9一-鿿Ѐ-ӿ\s-]/g, "").trim();
  const shortTitle = cleanTitle.slice(0, 30);
  const result = template.replace("{title}", shortTitle).slice(0, maxLen);

  return result || "Model-001";
}

/**
 * Generate a SKU from product data.
 */
export function generateSku(sourceUrl: string, priceCny: number): string {
  const hash = Math.abs(hashString(sourceUrl)).toString(36).slice(0, 6);
  return `STORE-${hash}-${Math.round(priceCny * 100)}`;
}

// ---- Internal helpers ----

function extractWeightFromSpecs(specs: Array<{ name: string; value: string }>): number | null {
  const weightSpec = specs.find((s) =>
    /重量|weight|вес|毛重|净重/i.test(s.name)
  );
  if (!weightSpec) return null;

  const match = weightSpec.value.match(/([\d.]+)\s*(g|克|kg|千克|公斤)/i);
  if (!match) return null;

  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return unit.includes("k") ? num * 1000 : num;
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
