// ============================================================
// Listing Runner — shared listing pipeline execution
// Extracted from routes/process.route.ts so the route handler and
// the auto-publish-queue scheduled job run the exact same flow.
// Owns the heavy shared instances (browser pool, scraper, AI clients)
// via createListingInfra — created ONCE per process, never per job.
// ============================================================

import { ProductScraper, BrowserPool } from "@onzo/scraper-1688";
import { GlmVisionClient, DeepSeekClient, GlmRateLimiter, TokenTracker, estimateCost } from "@onzo/glm-integration";
import { OzonClient, AuthManager } from "@onzo/ozon-api-wrapper";
import { ProductValidator } from "@onzo/validation-layer";
import { logger } from "@onzo/logger";

import type { AppConfig } from "../config.js";
import { DeepSeekTranslator } from "../pipelines/deepseek-translator.js";
import {
  createPipelineContext,
  stepScrape,
  stepOcr,
  stepTranslate,
  stepMatchCategory,
  stepFillAttributes,
  stepDownloadAndUploadImages,
  stepCreateDraft,
  stepOpsReview,
  buildProcessedProduct,
  type PipelineContext,
} from "../pipelines/listing-pipeline.js";
import { getExchangeRate } from "./exchange-rate.js";
import { notifier } from "./notifier.js";
import { getCategoryTree } from "./category-cache.js";
import { fullComplianceCheck, checkChineseProductCompliance } from "./compliance.js";
import { registerCleanup } from "../middleware/shutdown.js";

// ---- Shared infrastructure (heavy instances — one per process) ----

export interface ListingInfra {
  browserPool: BrowserPool;
  scraper: ProductScraper;
  validator: ProductValidator;
  ozonClient: OzonClient;
  glmLimiter: GlmRateLimiter;
  tokenTracker: TokenTracker;
  visionClient: GlmVisionClient;
  deepseekClient: DeepSeekClient;
  deepseekTranslator: DeepSeekTranslator;
}

/**
 * Create the shared listing infrastructure. Must be called once at startup;
 * the same instances are used by the process route and the auto-publish job
 * (a second BrowserPool would spawn duplicate headless browsers).
 */
export function createListingInfra(config: AppConfig): ListingInfra {
  const browserPool = new BrowserPool({ maxBrowsers: config.scraper.maxBrowserPool });
  const scraper = new ProductScraper({
    headless: true,
    dataDir: "./data/browser",
    minDelayMs: config.scraper.requestDelayMin,
    maxDelayMs: config.scraper.requestDelayMax,
  });

  // Wire captcha notifications
  scraper.onCaptcha(async (event) => {
    await notifier.notify({
      level: "warn",
      event: "1688验证码",
      message: `${event.captchaType} captcha at ${event.url}. Scraper cooldown active.`,
      correlationId: `captcha-${Date.now()}`,
      metadata: { captchaType: event.captchaType, url: event.url },
    }).catch(() => {});
  });

  // Register cleanup for graceful shutdown
  registerCleanup(async () => {
    await scraper.close();
    logger.info("Browser scraper closed");
  });

  const validator = new ProductValidator();
  const ozonClient = new OzonClient({
    auth: new AuthManager({
      clients: [{ clientId: config.ozon.clientId, apiKey: config.ozon.apiKey }],
    }),
    baseUrl: config.ozon.baseUrl,
  });

  // AI rate limiter
  const glmLimiter = new GlmRateLimiter({
    maxConcurrent: config.maxAiConcurrency,
    tokensPerMinute: 60,
  });

  // Token tracker — must be created BEFORE AI clients
  const dailyLimit = parseInt(process.env.LLM_DAILY_TOKEN_LIMIT || "0", 10);
  const tokenTracker = new TokenTracker({
    dailyLimit,
    onLimitExceeded: (usage) => {
      logger.error({ dailyLimit, totalTokens: usage.totalTokens }, "Token limit exceeded");
    },
    persistFn: async (usage) => {
      const { getDb } = await import("../db/connection.js");
      const db = await getDb().catch(() => null);
      if (!db) {
        logger.warn("Token usage not persisted — DB unavailable");
        return;
      }
      const cost = estimateCost(usage);
      await db.run(
        "INSERT INTO token_usage (model, prompt_tokens, completion_tokens, total_tokens, provider, cost_estimate) VALUES (?, ?, ?, ?, ?, ?)",
        [usage.model, usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.provider, cost]
      ).catch((err) => {
        logger.error({ err, model: usage.model, tokens: usage.totalTokens }, "Failed to persist token usage — cost data lost");
      });
    },
  });

  // Vision OCR → GLM-4.6V-Flash (per rules.md)
  const visionClient = new GlmVisionClient({
    apiKey: config.kimi.apiKey,
    baseUrl: `${config.kimi.baseUrl}/chat/completions`,
    model: config.kimi.visionModel,
    tokenTracker,
  });

  // Text tasks → DeepSeek V4 Flash (per rules.md: P0 listing = deepseek-v4-flash)
  const deepseekClient = new DeepSeekClient({
    apiKey: config.deepseek.apiKey,
    baseUrl: config.deepseek.baseUrl,
    flashModel: config.deepseek.flashModel,
    proModel: config.deepseek.proModel,
    tokenTracker,
  });
  const deepseekTranslator = new DeepSeekTranslator(deepseekClient);

  return {
    browserPool, scraper, validator, ozonClient, glmLimiter,
    tokenTracker, visionClient, deepseekClient, deepseekTranslator,
  };
}

// ---- Pipeline run result ----

/** Non-exception termination of the pipeline (policy/validation blocks). */
export type ListingBlockKind = "cn_compliance" | "fx_unreliable" | "validation" | "compliance" | "ops_review";

export type ListingRunOutcome =
  | { kind: "success"; productId: number; offerId: string; titleRu: string }
  | { kind: "blocked"; blockKind: ListingBlockKind; reason: string }
  | { kind: "error"; error: Error };

export interface ListingRunResult {
  ctx: PipelineContext;
  outcome: ListingRunOutcome;
}

/**
 * Run the full 1688 → Ozon draft pipeline for one source URL.
 * Same flow as POST /api/process: scrape → CN compliance pre-check → OCR →
 * translate → category match → attributes → images → FX → build → validate →
 * compliance → ops review → create draft.
 *
 * Never throws — failures come back as outcome.kind = "error".
 * Queue/dead-letter bookkeeping is left to the caller.
 */
export async function runListingPipeline(
  infra: ListingInfra,
  params: { url: string; storeId?: string; correlationId?: string }
): Promise<ListingRunResult> {
  const { browserPool, scraper, validator, ozonClient, glmLimiter, visionClient, deepseekTranslator } = infra;
  const ctx = createPipelineContext(params.url, params.storeId ?? "store_1");
  if (params.correlationId) ctx.correlationId = params.correlationId;

  try {
    // Step 1: Scrape (browser-pooled)
    await browserPool.acquire();
    let scraped;
    try {
      scraped = await stepScrape(ctx, scraper, params.url);
    } finally {
      browserPool.release();
    }

    // ---- P6: Chinese product compliance pre-check (before OCR/translate) ----
    const cnCompliance = checkChineseProductCompliance(scraped.title, scraped.descriptionText);
    if (cnCompliance.blocked) {
      logger.warn({
        title: scraped.title.slice(0, 60),
        reason: cnCompliance.blockedReason,
        requiredCerts: cnCompliance.requiredCerts,
        correlationId: ctx.correlationId,
      }, "Product blocked by Chinese compliance check — requires certification");
      return { ctx, outcome: { kind: "blocked", blockKind: "cn_compliance", reason: cnCompliance.blockedReason || "Compliance blocked" } };
    }
    if (cnCompliance.warnings.length > 0) {
      logger.warn({
        title: scraped.title.slice(0, 60),
        warnings: cnCompliance.warnings,
        requiredCerts: cnCompliance.requiredCerts,
        correlationId: ctx.correlationId,
      }, "Product has compliance warnings — listing may require certification");
    }

    // Step 2: OCR (rate-limited)
    await glmLimiter.call(() => stepOcr(ctx, visionClient, scraped.specImages));

    // Step 3: Translate (DeepSeek Flash)
    const translated = await glmLimiter.call(() => stepTranslate(ctx, deepseekTranslator, scraped));

    // Step 4: Match category (DeepSeek Flash)
    const categoryTree = await getCategoryTree(ozonClient, { ttlHours: 24 });
    const category = await glmLimiter.call(() =>
      stepMatchCategory(ctx, deepseekTranslator, scraped, categoryTree)
    );

    // Step 5: Fill attributes (DeepSeek Flash)
    let requiredAttributes: Awaited<ReturnType<OzonClient["getCategoryAttributes"]>> = [];
    if (category.categoryId > 0) {
      const attrCategoryId = category.attributeCategoryId ?? category.categoryId;
      requiredAttributes = await ozonClient.getCategoryAttributes(attrCategoryId).catch(() => []);
    }
    if (requiredAttributes.length > 0) {
      await glmLimiter.call(() =>
        stepFillAttributes(ctx, deepseekTranslator, translated, category.categoryId, requiredAttributes)
      );
    }

    // Step 5.5: Download images locally + upload to Ozon CDN
    const allDetailImages = scraped.detailImages ?? [];
    await stepDownloadAndUploadImages(ctx, ozonClient, scraper, scraped.specImages, allDetailImages);

    // Step 6: Build + validate
    const fx = await getExchangeRate();
    if (!fx.reliable) {
      return {
        ctx,
        outcome: {
          kind: "blocked",
          blockKind: "fx_unreliable",
          reason: `Exchange rate unreliable: source=${fx.source}, rate=${fx.rate}. Blocked to prevent pricing errors.`,
        },
      };
    }
    const processed = buildProcessedProduct(ctx, {
      exchangeRate: fx.rate,
      defaultLength: 20,
      defaultWidth: 15,
      defaultHeight: 5,
      defaultWeight: 0.5,
    });
    ctx.processed = processed;

    const validation = validator.validate(processed);
    if (!validation.valid) {
      return {
        ctx,
        outcome: {
          kind: "blocked",
          blockKind: "validation",
          reason: `Validation: ${validation.errors.map((e) => e.message).join("; ")}`,
        },
      };
    }

    // Compliance check — block sanctioned categories before hitting Ozon
    const compliance = fullComplianceCheck({
      categoryId: processed.categoryId,
      categoryName: processed.categoryName,
      categoryPath: processed.categoryPath,
      titleRu: processed.titleRu,
      descriptionRu: processed.descriptionRu,
    });
    if (compliance.blocked) {
      return {
        ctx,
        outcome: { kind: "blocked", blockKind: "compliance", reason: `Compliance: ${compliance.blockedReason ?? "Category prohibited"}` },
      };
    }
    if (compliance.warnings.length > 0) {
      logger.warn({ warnings: compliance.warnings, correlationId: ctx.correlationId }, "Compliance warnings");
    }

    // Step 7: Ops-agent review before publishing to Ozon
    const review = await stepOpsReview(ctx, processed);
    if (!review.approved) {
      logger.warn({ taskId: ctx.taskId, reason: review.reason }, "Ops-agent rejected listing");
      return { ctx, outcome: { kind: "blocked", blockKind: "ops_review", reason: review.reason ?? "Ops review rejected" } };
    }
    if (review.riskLevel === "high") {
      logger.warn({ taskId: ctx.taskId, suggestions: review.suggestions }, "Ops-agent high risk — proceeding with caution");
    }

    const draftResult = await stepCreateDraft(ctx, ozonClient, processed);

    return {
      ctx,
      outcome: { kind: "success", productId: draftResult.productId, offerId: draftResult.offerId, titleRu: processed.titleRu },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { ctx, outcome: { kind: "error", error } };
  }
}
