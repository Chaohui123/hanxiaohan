// ============================================================
// Production Configuration Validation
// Called at startup — fails fast on missing/invalid secrets.
// Prevents runtime errors from placeholder credentials.
// ============================================================

import { logger } from "@onzo/logger";

interface ValidationRule {
  key: string;
  required: boolean;
  minLength?: number;
  /** Reject if any of these substrings appear in the value */
  blockedSubstrings?: string[];
}

const SECURITY_RULES: ValidationRule[] = [
  { key: "ENCRYPTION_KEY", required: true, minLength: 32, blockedSubstrings: ["change_me", "CHANGE_ME", "your_", "YOUR_", "placeholder"] },
  { key: "OZON_API_KEYS", required: true, minLength: 10, blockedSubstrings: ["CHANGE_ME", "YOUR_"] },
  { key: "OZON_CLIENT_IDS", required: true, minLength: 3, blockedSubstrings: ["CHANGE_ME", "YOUR_"] },
  { key: "GLM_API_KEY", required: true, minLength: 10, blockedSubstrings: ["CHANGE_ME", "YOUR_"] },
  { key: "DEEPSEEK_API_KEY", required: true, minLength: 10, blockedSubstrings: ["CHANGE_ME", "YOUR_"] },
  { key: "API_KEY", required: true, minLength: 16, blockedSubstrings: ["CHANGE_ME", "YOUR_"] },
  { key: "N8N_PASSWORD", required: true, minLength: 8, blockedSubstrings: ["CHANGE_ME", "change_me"] },
  { key: "N8N_ENCRYPTION_KEY", required: true, minLength: 16, blockedSubstrings: ["CHANGE_ME", "change_me"] },
];

const COS_RULES: ValidationRule[] = [
  { key: "COS_SECRET_ID", required: false, minLength: 10 },
  { key: "COS_SECRET_KEY", required: false, minLength: 10 },
];

const DOCKER_RULES: ValidationRule[] = [
  { key: "POSTGRES_PASSWORD", required: false, minLength: 12, blockedSubstrings: ["CHANGE_ME", "Onzo@Prod", "password"] },
  { key: "REDIS_PASSWORD", required: false, minLength: 12, blockedSubstrings: ["CHANGE_ME", "Redis@Onzo", "password"] },
];

/**
 * Validate all production-critical environment variables.
 * Call once at startup in index.ts.
 * Throws on first invalid value — fail fast, fail loud.
 */
export function validateProductionConfig(): void {
  const isProduction = (process.env.ENV || process.env.NODE_ENV) === "production";

  if (!isProduction) {
    logger.info("Skipping production config validation — not in production mode");
    return;
  }

  logger.info("Validating production configuration...");
  const errors: string[] = [];

  function check(rule: ValidationRule): void {
    const value = process.env[rule.key];

    if (!value || value.trim() === "") {
      if (rule.required) {
        errors.push(`${rule.key}: REQUIRED but not set. Add to .env file.`);
      }
      return;
    }

    if (rule.minLength && value.length < rule.minLength) {
      errors.push(`${rule.key}: too short (${value.length} chars, need >= ${rule.minLength}).`);
    }

    if (rule.blockedSubstrings) {
      for (const blocked of rule.blockedSubstrings) {
        if (value.toLowerCase().includes(blocked.toLowerCase())) {
          errors.push(`${rule.key}: contains placeholder text "${blocked}". Replace with real value.`);
          break;
        }
      }
    }
  }

  for (const rule of SECURITY_RULES) check(rule);

  // Docker passwords are only required if Docker services are enabled
  const usingDocker = process.env.DOCKER_ENABLED === "true" || process.env.POSTGRES_PASSWORD;
  if (usingDocker) {
    for (const rule of DOCKER_RULES) {
      if (process.env[rule.key]) check(rule);
    }
  }

  // COS is optional — only validate if configured
  const usingCOS = process.env.COS_SECRET_ID || process.env.COS_SECRET_KEY;
  if (usingCOS) {
    for (const rule of COS_RULES) check(rule);
    if (process.env.COS_SECRET_ID && !process.env.COS_SECRET_KEY) {
      errors.push("COS_SECRET_ID set but COS_SECRET_KEY missing.");
    }
  }

  if (errors.length > 0) {
    const msg = `Production config validation FAILED:\n  - ${errors.join("\n  - ")}\n` +
      "Fix these issues in your .env file before restarting.";
    logger.fatal(msg);
    throw new Error(msg);
  }

  logger.info("Production config validation PASSED");
}
