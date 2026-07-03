// ============================================================
// Validation types
// ============================================================

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  stats: {
    totalChecks: number;
    passed: number;
    failed: number;
    warned: number;
  };
}

export interface ValidationError {
  field: string;
  code: string;
  message: string;
  severity: "error" | "warning";
  context?: Record<string, unknown>;
}

export interface ValidationWarning {
  field: string;
  code: string;
  message: string;
  suggestion?: string;
}

export interface PricingConfig {
  minMarginPercent: number; // 15 = 15% minimum margin
  exchangeRate?: number; // CNY→RUB, auto-fetched if not provided
  exchangeRateTimestamp?: string;
}
