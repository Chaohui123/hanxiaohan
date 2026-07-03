// ============================================================
// POST /api/process — Full pipeline entry point
// Uses pipelines/listing-pipeline.ts step functions
// ============================================================

import { Router } from "express";
import type { TaskQueue } from "../db/task-queue.js";
import type { AppConfig } from "../config.js";
import { ProductScraper, BrowserPool } from "@onzo/scraper-1688";
import { GlmVisionClient, DeepSeekClient, GlmRateLimiter, TokenTracker, estimateCost } from "@onzo/glm-integration";
import { DeepSeekTranslator } from "../pipelines/deepseek-translator.js";
import { ProductValidator } from "@onzo/validation-layer";
import { OzonClient, AuthManager } from "@onzo/ozon-api-wrapper";
import {
  createPipelineContext,
  stepScrape,
  stepOcr,
  stepTranslate,
  stepMatchCategory,
  stepFillAttributes,
  stepUploadImages,
  stepCreateDraft,
  buildProcessedProduct,
  recordPipelineFailure,
  recordPipelineSuccess,
} from "../pipelines/listing-pipeline.js";

export function createProcessRouter(config: AppConfig, taskQueue: TaskQueue): Router {
  const router = Router();

  // Shared instances — created once at startup
  const browserPool = new BrowserPool({ maxBrowsers: config.scraper.maxBrowserPool });
  const scraper = new ProductScraper({
    headless: true,
    minDelayMs: config.scraper.requestDelayMin,
    maxDelayMs: config.scraper.requestDelayMax,
  });

  // Vision OCR → GLM-4.6V-Flash (per rules.md)
  const visionClient = new GlmVisionClient({
    apiKey: config.glm.apiKey,
    baseUrl: `${config.glm.baseUrl}/chat/completions`,
    model: config.glm.visionModel,
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

  // Token tracker — persists to SQLite, enforces daily limit
  const dailyLimit = parseInt(process.env.LLM_DAILY_TOKEN_LIMIT || "0", 10);
  const tokenTracker = new TokenTracker({
    dailyLimit,
    onLimitExceeded: (usage) => {
      console.error(`[TOKEN LIMIT] Daily limit (${dailyLimit}) exceeded! Total: ${usage.totalTokens}`);
    },
    persistFn: async (usage) => {
      const { getDb } = await import("../db/connection.js");
      const db = await getDb().catch(() => null);
      if (!db) return;
      const cost = estimateCost(usage);
      await db.run(
        "INSERT INTO token_usage (model, prompt_tokens, completion_tokens, total_tokens, provider, cost_estimate) VALUES (?, ?, ?, ?, ?, ?)",
        [usage.model, usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.provider, cost]
      ).catch(() => {});
    },
  });

  // POST /api/process
  router.post("/process", async (req, res) => {
    const { url: sourceUrl, storeId } = req.body as { url: string; storeId?: string };
    const store = storeId ?? "store_1";

    if (!sourceUrl) {
      res.status(400).json({
        success: false,
        error: { code: "MISSING_URL", message: "Field 'url' is required", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }

    // Enqueue task
    const queued = await taskQueue.enqueue({
      type: "listing",
      payload: { url: sourceUrl },
      correlationId: req.correlationId,
      storeId: store,
    });

    res.status(202).json({
      success: true,
      data: { taskId: queued.id, status: "queued" },
      message: "Listing task queued. Poll GET /api/task/queue/stats for progress.",
      correlationId: req.correlationId,
    });

    // Execute pipeline asynchronously (with browser pool + GLM rate limiting)
    const ctx = createPipelineContext(sourceUrl, store);
    await taskQueue.markProcessing(queued.id);

    try {
      // Step 1: Scrape (browser-pooled)
      await browserPool.acquire();
      let scraped;
      try {
        scraped = await stepScrape(ctx, scraper, sourceUrl);
      } finally {
        browserPool.release();
      }

      // Step 2: OCR (rate-limited)
      const ocrTexts = await glmLimiter.call(() =>
        stepOcr(ctx, visionClient, scraped.specImages)
      );

      // Step 3: Translate (DeepSeek Flash)
      const translated = await glmLimiter.call(() =>
        stepTranslate(ctx, deepseekTranslator, scraped)
      );

      // Step 4: Match category (DeepSeek Flash)
      const categoryTree = await ozonClient.getCategoryTree();
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

      // Step 6: Build + validate
      const processed = buildProcessedProduct(ctx, {
        exchangeRate: 11.5,
        defaultLength: 20,
        defaultWidth: 15,
        defaultHeight: 5,
        defaultWeight: 0.5,
      });
      ctx.processed = processed;

      const validation = validator.validate(processed);
      if (!validation.valid) {
        taskQueue.markFailed(queued.id, `Validation: ${validation.errors.map((e) => e.message).join("; ")}`)
          .catch((dbErr) => console.error(`[${ctx.correlationId}] Failed to mark validation failure:`, dbErr));
        return;
      }

      // Step 7: Create draft with image URLs directly (Ozon imports them)
      const draftResult = await stepCreateDraft(ctx, ozonClient, processed);

      // Success
      recordPipelineSuccess(ctx).catch((dbErr) =>
        console.error(`[${ctx.correlationId}] Failed to record success:`, dbErr)
      );
      taskQueue.markDone(queued.id).catch((dbErr) =>
        console.error(`[${ctx.correlationId}] Failed to mark done:`, dbErr)
      );

      console.log(`[${ctx.correlationId}] Draft created: ${draftResult.productId}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[${ctx.correlationId}] Pipeline failed:`, error.message);

      // Fire-and-forget error recording — don't let DB errors crash the handler
      recordPipelineFailure(ctx, error).catch((dbErr) =>
        console.error(`[${ctx.correlationId}] Failed to record pipeline failure:`, dbErr)
      );
      taskQueue.markFailed(queued.id, error.message).catch((dbErr) =>
        console.error(`[${ctx.correlationId}] Failed to mark task as failed:`, dbErr)
      );
    }
  });

  // POST /api/process/sync — synchronous version (for direct testing)
  router.post("/process/sync", async (req, res) => {
    const { url: sourceUrl, storeId } = req.body as { url: string; storeId?: string };

    if (!sourceUrl) {
      res.status(400).json({
        success: false,
        error: { code: "MISSING_URL", message: "Field 'url' is required", retryable: false },
        correlationId: req.correlationId,
      });
      return;
    }

    const ctx = createPipelineContext(sourceUrl, storeId);

    try {
      // Use browser pool to limit concurrency
      await browserPool.acquire();
      let scraped;
      try { scraped = await stepScrape(ctx, scraper, sourceUrl); }
      finally { browserPool.release(); }

      const ocrTexts = await stepOcr(ctx, visionClient, scraped.specImages);
      const translated = await stepTranslate(ctx, deepseekTranslator, scraped);

      // Ozon API calls (not in step functions — wrap errors manually)
      let categoryTree;
      try {
        categoryTree = await ozonClient.getCategoryTree();
      } catch (err) {
        const msg = `Ozon category tree failed: ${(err as Error).message}`;
        ctx.errors.push({ step: "category_tree", message: msg });
        throw err;
      }
      const category = await stepMatchCategory(ctx, deepseekTranslator, scraped, categoryTree);
      ctx.categoryTree = categoryTree;

      let requiredAttributes: Awaited<ReturnType<OzonClient["getCategoryAttributes"]>> = [];
      if (category.categoryId > 0) {
        try {
          const attrCategoryId = category.attributeCategoryId ?? category.categoryId;
          requiredAttributes = await ozonClient.getCategoryAttributes(attrCategoryId);
        } catch (err) {
          const msg = `Ozon category attributes failed: ${(err as Error).message}`;
          ctx.errors.push({ step: "category_attrs", message: msg });
          // non-fatal — continue with empty attributes
          requiredAttributes = [];
        }
      }
      if (requiredAttributes.length > 0) {
        await stepFillAttributes(ctx, deepseekTranslator, translated, category.categoryId, requiredAttributes);
      }

      const processed = buildProcessedProduct(ctx, {
        exchangeRate: 11.5,
        defaultLength: 20, defaultWidth: 15, defaultHeight: 5, defaultWeight: 0.5,
      });
      ctx.processed = processed;

      const validation = validator.validate(processed);
      if (!validation.valid) {
        res.status(422).json({
          success: false,
          error: { code: "VALIDATION_FAILED", message: "Validation failed", retryable: false },
          details: validation.errors,
          correlationId: ctx.correlationId,
        });
        return;
      }

      const draftResult = await stepCreateDraft(ctx, ozonClient, processed);

      await recordPipelineSuccess(ctx);

      res.json({
        success: true,
        data: {
          taskId: ctx.taskId,
          draftId: draftResult.offerId,
          ozonProductId: draftResult.productId,
          titleRu: processed.titleRu,
          categoryName: processed.categoryName,
          priceRub: processed.priceRub,
          imagesUploaded: scraped.specImages.length,
        },
        correlationId: ctx.correlationId,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await recordPipelineFailure(ctx, error);

      res.status(500).json({
        success: false,
        error: {
          code: "PIPELINE_FAILED",
          message: error.message,
          retryable: error.name === "RetryableError" || error.name === "RateLimitError",
        },
        errors: ctx.errors,
        correlationId: ctx.correlationId,
      });
    }
  });

  // POST /api/process/manual — skip scraper, input product JSON manually
  router.post("/process/manual", async (req, res) => {
    const { title, priceCny, specImages, detailImages, specifications, descriptionText } = req.body as {
      title: string; priceCny: number; specImages: string[]; detailImages?: string[]; specifications?: Array<{name:string;value:string}>; descriptionText?: string;
    };

    if (!title || !priceCny || !specImages?.length) {
      res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "title, priceCny, specImages required", retryable: false }, correlationId: req.correlationId });
      return;
    }

    const scraped = {
      sourceUrl: "manual-input",
      scrapeTimestamp: new Date().toISOString(),
      title,
      price: { currentMin: priceCny, currentMax: priceCny, currency: "CNY" as const },
      specImages,
      detailImages: detailImages ?? [],
      specifications: specifications ?? [],
      descriptionText: descriptionText ?? title,
      categoryPath: [] as string[],
    };

    const ctx = createPipelineContext("manual-input");
    ctx.scraped = scraped; // Set directly since we skip stepScrape
    try {
      const ocrTexts = await stepOcr(ctx, visionClient, scraped.specImages.slice(0, 5));
      const translated = await stepTranslate(ctx, deepseekTranslator, scraped);

      let categoryTree;
      try { categoryTree = await ozonClient.getCategoryTree(); } catch (err) {
        ctx.errors.push({ step: "category_tree", message: `Ozon category tree failed: ${(err as Error).message}` });
        throw err;
      }
      const category = await stepMatchCategory(ctx, deepseekTranslator, scraped, categoryTree);
      ctx.categoryTree = categoryTree;

      let requiredAttributes: Awaited<ReturnType<OzonClient["getCategoryAttributes"]>> = [];
      if (category.categoryId > 0) {
        try {
          const attrCategoryId = category.attributeCategoryId ?? category.categoryId;
          requiredAttributes = await ozonClient.getCategoryAttributes(attrCategoryId);
        } catch {
          requiredAttributes = [];
        }
      }
      if (requiredAttributes.length > 0) {
        await stepFillAttributes(ctx, deepseekTranslator, translated, category.categoryId, requiredAttributes);
      }

      const processed = buildProcessedProduct(ctx, {
        exchangeRate: 11.5, defaultLength: 20, defaultWidth: 15, defaultHeight: 5, defaultWeight: 0.5,
      });
      ctx.processed = processed;

      const validation = validator.validate(processed);
      if (!validation.valid) {
        res.status(422).json({ success: false, error: { code: "VALIDATION_FAILED", message: "Validation failed", retryable: false }, details: validation.errors, correlationId: ctx.correlationId });
        return;
      }

      const draftResult = await stepCreateDraft(ctx, ozonClient, processed);

      await recordPipelineSuccess(ctx);

      res.json({
        success: true,
        data: { taskId: ctx.taskId, draftId: draftResult.offerId, ozonProductId: draftResult.productId, titleRu: processed.titleRu, categoryName: processed.categoryName, priceRub: processed.priceRub, imagesUploaded: processed.specImageUrls.length },
        correlationId: ctx.correlationId,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await recordPipelineFailure(ctx, error);
      res.status(500).json({ success: false, error: { code: "PIPELINE_FAILED", message: error.message, retryable: false }, errors: ctx.errors, correlationId: ctx.correlationId });
    }
  });

  // GET /api/debug/scrape — debug endpoint: raw scraper output
  router.get("/debug/scrape", async (req, res) => {
    const url = (req.query.url as string) || "https://detail.1688.com/offer/891784406688.html";
    try {
      const result = await scraper.scrapeProduct(url);
      res.json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message, correlationId: req.correlationId });
    }
  });

  return router;
}
