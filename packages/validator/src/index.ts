// ============================================================
// Product Validator — Pre-Ozon submission data quality check
// ============================================================

import type {
  ProcessedProduct,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  PricingConfig,
  OzonAttribute,
} from "@onzo/shared-types";

export interface ValidatorConfig {
  strictMode?: boolean;
  pricingConfig?: PricingConfig;
}

const DEFAULT_CONFIG: ValidatorConfig = {
  strictMode: true,
  pricingConfig: {
    minMarginPercent: 15,
  },
};

export class ProductValidator {
  private config: Required<Omit<ValidatorConfig, "pricingConfig">> & {
    pricingConfig: PricingConfig;
  };

  constructor(config?: ValidatorConfig) {
    this.config = {
      strictMode: config?.strictMode ?? DEFAULT_CONFIG.strictMode!,
      pricingConfig: {
        minMarginPercent: DEFAULT_CONFIG.pricingConfig!.minMarginPercent,
        ...config?.pricingConfig,
      },
    };
  }

  /**
   * Full validation — runs all checks.
   */
  validate(product: ProcessedProduct): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    let totalChecks = 0;
    let passed = 0;

    // Title checks
    const titleResults = this.validateTitle(product);
    errors.push(...titleResults.errors);
    warnings.push(...titleResults.warnings);
    totalChecks += 3;
    passed += titleResults.passed;

    // Description checks
    const descResults = this.validateDescription(product);
    errors.push(...descResults.errors);
    warnings.push(...descResults.warnings);
    totalChecks += 2;
    passed += descResults.passed;

    // Pricing checks
    const priceResults = this.validatePricing(product);
    errors.push(...priceResults.errors);
    warnings.push(...priceResults.warnings);
    totalChecks += 3;
    passed += priceResults.passed;

    // Image checks
    const imgResults = this.validateImages(product);
    errors.push(...imgResults.errors);
    warnings.push(...imgResults.warnings);
    totalChecks += 3;
    passed += imgResults.passed;

    // Category checks
    const catResults = this.validateCategory(product);
    errors.push(...catResults.errors);
    warnings.push(...catResults.warnings);
    totalChecks += 2;
    passed += catResults.passed;

    // Dimension checks
    const dimResults = this.validateDimensions(product);
    errors.push(...dimResults.errors);
    warnings.push(...dimResults.warnings);
    totalChecks += 3;
    passed += dimResults.passed;

    return {
      valid: errors.length === 0 || !this.config.strictMode,
      errors,
      warnings,
      stats: {
        totalChecks,
        passed,
        failed: errors.length,
        warned: warnings.length,
      },
    };
  }

  // ============================================================
  // Individual validation methods
  // ============================================================

  validateTitle(product: Pick<ProcessedProduct, "titleRu">): {
    errors: ValidationError[];
    warnings: ValidationWarning[];
    passed: number;
  } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    let passed = 0;

    // Required
    if (!product.titleRu || product.titleRu.trim().length === 0) {
      errors.push({ field: "titleRu", code: "MISSING_TITLE", message: "Product title is required", severity: "error" });
    } else {
      passed++;

      // Length
      if (product.titleRu.length < 10) {
        errors.push({
          field: "titleRu",
          code: "TITLE_TOO_SHORT",
          message: `Title must be at least 10 characters (currently ${product.titleRu.length})`,
          severity: "error",
          context: { min: 10, actual: product.titleRu.length },
        });
      } else {
        passed++;
      }

      if (product.titleRu.length > 2000) {
        errors.push({
          field: "titleRu",
          code: "TITLE_TOO_LONG",
          message: `Title must be under 2000 characters (currently ${product.titleRu.length})`,
          severity: "error",
          context: { max: 2000, actual: product.titleRu.length },
        });
      } else {
        passed++;
      }
    }

    return { errors, warnings, passed };
  }

  validateDescription(product: Pick<ProcessedProduct, "descriptionRu">): {
    errors: ValidationError[];
    warnings: ValidationWarning[];
    passed: number;
  } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    let passed = 0;

    if (!product.descriptionRu || product.descriptionRu.trim().length === 0) {
      errors.push({
        field: "descriptionRu",
        code: "MISSING_DESCRIPTION",
        message: "Product description is required",
        severity: "error",
      });
    } else {
      passed++;

      if (product.descriptionRu.length > 5000) {
        warnings.push({
          field: "descriptionRu",
          code: "DESCRIPTION_LONG",
          message: `Description is ${product.descriptionRu.length} chars — Ozon recommends under 5000`,
        });
      } else {
        passed++;
      }
    }

    return { errors, warnings, passed };
  }

  validatePricing(product: Pick<ProcessedProduct, "priceRub" | "priceCny">): {
    errors: ValidationError[];
    warnings: ValidationWarning[];
    passed: number;
  } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    let passed = 0;

    // Price > 0
    if (!product.priceRub || product.priceRub <= 0) {
      errors.push({
        field: "priceRub",
        code: "MISSING_PRICE",
        message: "Product price must be greater than 0",
        severity: "error",
      });
    } else {
      passed++;

      // Sanity: max price
      if (product.priceRub > 999999) {
        errors.push({
          field: "priceRub",
          code: "PRICE_OUT_OF_RANGE",
          message: `Price ${product.priceRub} RUB is above max limit (999999)`,
          severity: "error",
        });
      } else {
        passed++;
      }

      // Loss prevention (only if we have CNY cost)
      if (product.priceCny && product.priceCny.min > 0) {
        const exchangeRate = this.config.pricingConfig.exchangeRate ?? 11.5;
        const costRub = product.priceCny.min * exchangeRate;
        const minPrice = costRub * (1 + this.config.pricingConfig.minMarginPercent / 100);

        if (product.priceRub < minPrice) {
          errors.push({
            field: "priceRub",
            code: "PRICE_BELOW_MIN_MARGIN",
            message: `Price ${product.priceRub} RUB is below minimum ${minPrice.toFixed(0)} RUB (${this.config.pricingConfig.minMarginPercent}% margin)`,
            severity: "error",
            context: { costRub, minPrice, marginPercent: this.config.pricingConfig.minMarginPercent },
          });
        } else {
          passed++;
        }
      }

      // Warning: price ends with .99 (Ozon convention)
      if (product.priceRub % 100 > 0 && String(product.priceRub).endsWith("99")) {
        warnings.push({
          field: "priceRub",
          code: "PRICE_FORMAT",
          message: "Consider round pricing — Ozon doesn't require .99 psychological pricing",
        });
      }
    }

    return { errors, warnings, passed };
  }

  validateImages(product: Pick<ProcessedProduct, "specImageUrls" | "imageIds">): {
    errors: ValidationError[];
    warnings: ValidationWarning[];
    passed: number;
  } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    let passed = 0;

    const imageList = (product.imageIds && product.imageIds.length > 0)
      ? product.imageIds
      : (product.specImageUrls ?? []);

    if (imageList.length === 0) {
      errors.push({
        field: "images",
        code: "MISSING_IMAGES",
        message: "At least 1 product image is required",
        severity: "error",
      });
    } else {
      passed++;

      if (imageList.length > 15) {
        errors.push({
          field: "images",
          code: "TOO_MANY_IMAGES",
          message: `Maximum 15 images allowed, found ${imageList.length}`,
          severity: "error",
        });
      } else {
        passed++;
      }

      // Check for duplicates
      const unique = new Set(imageList);
      if (unique.size < imageList.length) {
        warnings.push({
          field: "images",
          code: "DUPLICATE_IMAGES",
          message: `${imageList.length - unique.size} duplicate images detected`,
        });
      } else {
        passed++;
      }
    }

    return { errors, warnings, passed };
  }

  validateCategory(product: Pick<ProcessedProduct, "categoryId" | "attributes">): {
    errors: ValidationError[];
    warnings: ValidationWarning[];
    passed: number;
  } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    let passed = 0;

    if (!product.categoryId || product.categoryId <= 0) {
      errors.push({
        field: "categoryId",
        code: "MISSING_CATEGORY",
        message: "Valid Ozon category ID is required",
        severity: "error",
      });
    } else {
      passed++;
    }

    if (!product.attributes || product.attributes.length === 0) {
      // Phase 1: attributes are optional — Ozon will reject if required fields missing
      warnings.push({
        field: "attributes",
        code: "ATTRIBUTES_EMPTY",
        message: "No attributes filled. Ozon may reject the draft if required fields are missing.",
      });
    } else {
      passed++;
    }

    return { errors, warnings, passed };
  }

  validateDimensions(product: Pick<ProcessedProduct, "dimensionsCm" | "weightKg">): {
    errors: ValidationError[];
    warnings: ValidationWarning[];
    passed: number;
  } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    let passed = 0;

    const dims = product.dimensionsCm;
    if (!dims || !dims.length || !dims.width || !dims.height) {
      errors.push({
        field: "dimensionsCm",
        code: "MISSING_DIMENSIONS",
        message: "Product dimensions (length, width, height) are required",
        severity: "error",
      });
    } else {
      passed++;

      // Sanity checks
      for (const [key, value] of Object.entries(dims)) {
        if (value < 1) {
          errors.push({
            field: `dimensionsCm.${key}`,
            code: "DIMENSION_TOO_SMALL",
            message: `${key} must be at least 1 cm`,
            severity: "error",
          });
        } else if (value > 200) {
          warnings.push({
            field: `dimensionsCm.${key}`,
            code: "DIMENSION_SUSPICIOUS",
            message: `${key} is ${value} cm — please verify this is correct`,
          });
        }
      }

      // Volume sanity
      const volume = dims.length * dims.width * dims.height;
      if (volume > 500000) {
        warnings.push({
          field: "dimensionsCm",
          code: "VOLUME_SUSPICIOUS",
          message: `Product volume is ${(volume / 1000000).toFixed(2)} m³ — please verify`,
        });
      }
    }

    if (!product.weightKg || product.weightKg <= 0) {
      errors.push({
        field: "weightKg",
        code: "MISSING_WEIGHT",
        message: "Product weight is required",
        severity: "error",
      });
    } else {
      passed++;

      if (product.weightKg < 0.01) {
        errors.push({
          field: "weightKg",
          code: "WEIGHT_TOO_SMALL",
          message: "Weight must be at least 0.01 kg",
          severity: "error",
        });
      } else if (product.weightKg > 50) {
        warnings.push({
          field: "weightKg",
          code: "WEIGHT_SUSPICIOUS",
          message: `Weight is ${product.weightKg} kg — please verify`,
        });
      } else {
        passed++;
      }
    }

    return { errors, warnings, passed };
  }
}

export type { ValidationResult, ValidationError, ValidationWarning, PricingConfig };
