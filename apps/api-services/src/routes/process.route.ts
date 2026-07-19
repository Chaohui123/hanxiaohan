// ============================================================
// POST /api/process — Full pipeline entry point
// Uses pipelines/listing-pipeline.ts step functions
// ============================================================

import { Router } from "express";
import type { TaskQueue } from "../db/task-queue.js";
import type { AppConfig } from "../config.js";
import { getExchangeRate } from "../services/exchange-rate.js";
import { notifier } from "../services/notifier.js";
import { writeToDeadLetter } from "../services/dead-letter.js";
import { getCategoryTree } from "../services/category-cache.js";
import { fullComplianceCheck, checkChineseProductCompliance } from "../services/compliance.js";
import { validateBody } from "../middleware/validate.js";
import { logger } from "@onzo/logger";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { runListingPipeline, type ListingInfra } from "../services/listing-runner.js";
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
  recordPipelineFailure,
  recordPipelineSuccess,
  findNearestAncestorWithAttributes,
} from "../pipelines/listing-pipeline.js";

export function createProcessRouter(config: AppConfig, taskQueue: TaskQueue, listingInfra: ListingInfra): Router {
  const router = Router();

  // Shared instances — created once at startup (see services/listing-runner.ts)
  const { browserPool, scraper, validator, ozonClient, visionClient, deepseekTranslator } = listingInfra;

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

    // Execute pipeline asynchronously (shared runner — services/listing-runner.ts)
    await taskQueue.markProcessing(queued.id);
    const { ctx, outcome } = await runListingPipeline(listingInfra, { url: sourceUrl, storeId: store });

    if (outcome.kind === "success") {
      recordPipelineSuccess(ctx).catch((dbErr) =>
        logger.error({ correlationId: ctx.correlationId, err: dbErr }, "Failed to record success")
      );
      taskQueue.markDone(queued.id).catch((dbErr) =>
        logger.error({ correlationId: ctx.correlationId, err: dbErr }, "Failed to mark done")
      );

      logger.info({ correlationId: ctx.correlationId, productId: outcome.productId }, "Draft created");
      notifier.notifySuccess(ctx.correlationId, outcome.titleRu, outcome.offerId, outcome.productId).catch(() => {});
      return;
    }

    if (outcome.kind === "blocked") {
      if (outcome.blockKind === "cn_compliance") {
        // Stop pipeline — don't waste API calls on blocked products
        await taskQueue.markFailed(queued.id, outcome.reason);
        await recordPipelineFailure(ctx, new Error(outcome.reason));
      } else if (outcome.blockKind === "fx_unreliable") {
        taskQueue.markFailed(queued.id, outcome.reason)
          .catch((dbErr) => logger.error({ correlationId: ctx.correlationId, err: dbErr }, "Failed to mark rate-blocked task"));
      } else if (outcome.blockKind === "validation") {
        taskQueue.markFailed(queued.id, outcome.reason)
          .catch((dbErr) => logger.error({ correlationId: ctx.correlationId, err: dbErr }, "Failed to mark validation failure"));
      } else if (outcome.blockKind === "compliance") {
        taskQueue.markFailed(queued.id, outcome.reason)
          .catch((dbErr) => logger.error({ correlationId: ctx.correlationId, err: dbErr }, "Failed to mark compliance block"));
      }
      // ops_review rejections are already logged by the runner — nothing else to do
      return;
    }

    // outcome.kind === "error"
    const error = outcome.error;
    logger.error({ correlationId: ctx.correlationId, err: error }, "Pipeline failed");

    // Write to dead letter queue for smart retry
    writeToDeadLetter({
      taskType: "listing",
      errorMessage: error.message,
      payload: { url: sourceUrl },
      storeId: store,
      correlationId: ctx.correlationId,
    }).catch(() => {});

    // Notify failure
    notifier.notifyFailure(ctx.correlationId, "pipeline", error.message, sourceUrl).catch(() => {});

    // Fire-and-forget error recording — don't let DB errors crash the handler
    recordPipelineFailure(ctx, error).catch((dbErr) =>
      logger.error({ correlationId: ctx.correlationId, err: dbErr }, "Failed to record pipeline failure")
    );
    taskQueue.markFailed(queued.id, error.message).catch((dbErr) =>
      logger.error({ correlationId: ctx.correlationId, err: dbErr }, "Failed to mark task as failed")
    );
  });

  // POST /api/process/sync — synchronous version (for direct testing)
  router.post("/process/sync",
    validateBody([{ field: "url", type: "string", required: true }]),
    async (req, res) => {
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

      // P6: Chinese compliance pre-check (before OCR/translate)
      const cnCompSync = checkChineseProductCompliance(scraped.title, scraped.descriptionText);
      if (cnCompSync.blocked) {
        return res.status(422).json({
          success: false,
          error: { code: "COMPLIANCE_BLOCKED", message: cnCompSync.blockedReason || "Product requires certification", requiredCerts: cnCompSync.requiredCerts, retryable: false },
          correlationId: req.correlationId,
        });
      }

      const ocrTexts = await stepOcr(ctx, visionClient, scraped.specImages);
      const translated = await stepTranslate(ctx, deepseekTranslator, scraped);

      // Ozon API calls (not in step functions — wrap errors manually)
      let categoryTree;
      try {
        categoryTree = await getCategoryTree(ozonClient, { ttlHours: 24 });
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

      // Download + upload images
      const allDetailImages = scraped.detailImages ?? [];
      await stepDownloadAndUploadImages(ctx, ozonClient, scraper, scraped.specImages, allDetailImages);

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

      // Compliance check
      const compliance = fullComplianceCheck({
        categoryId: processed.categoryId,
        categoryName: processed.categoryName,
        categoryPath: processed.categoryPath,
        titleRu: processed.titleRu,
        descriptionRu: processed.descriptionRu,
      });
      if (compliance.blocked) {
        res.status(422).json({
          success: false,
          error: { code: "COMPLIANCE_BLOCKED", message: compliance.blockedReason ?? "Category prohibited", retryable: false },
          warnings: compliance.warnings,
          correlationId: ctx.correlationId,
        });
        return;
      }

      // Ops-agent review before publishing to Ozon
      const review = await stepOpsReview(ctx, processed);
      if (!review.approved) {
        logger.warn({ taskId: ctx.taskId, reason: review.reason }, "Ops-agent rejected listing");
        return;
      }
      if (review.riskLevel === "high") {
        logger.warn({ taskId: ctx.taskId, suggestions: review.suggestions }, "Ops-agent high risk — proceeding with caution");
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
          complianceWarnings: compliance.warnings.length > 0 ? compliance.warnings : undefined,
        },
        correlationId: ctx.correlationId,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await recordPipelineFailure(ctx, error);

      // Dead letter for sync pipeline failures
      writeToDeadLetter({
        taskType: "listing_sync",
        errorMessage: error.message,
        payload: { url: sourceUrl },
        storeId: storeId ?? "store_1",
        correlationId: ctx.correlationId,
      }).catch(() => {});

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
  router.post("/process/manual",
    validateBody([
      { field: "title", type: "string", required: true, min: 10, max: 2000 },
      { field: "priceCny", type: "number", required: true },
      { field: "specImages", type: "array", required: true, min: 1, max: 15 },
    ]),
    async (req, res) => {
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

    // P6: Chinese compliance pre-check
    const cnCompManual = checkChineseProductCompliance(scraped.title, scraped.descriptionText);
    if (cnCompManual.blocked) {
      return res.status(422).json({
        success: false,
        error: { code: "COMPLIANCE_BLOCKED", message: cnCompManual.blockedReason || "Product requires certification", requiredCerts: cnCompManual.requiredCerts, retryable: false },
        correlationId: req.correlationId,
      });
    }

    try {
      const ocrTexts = await stepOcr(ctx, visionClient, scraped.specImages.slice(0, 5));
      const translated = await stepTranslate(ctx, deepseekTranslator, scraped);

      let categoryTree;
      try { categoryTree = await getCategoryTree(ozonClient, { ttlHours: 24 }); } catch (err) {
        ctx.errors.push({ step: "category_tree", message: `Ozon category tree failed: ${(err as Error).message}` });
        throw err;
      }
      const category = await stepMatchCategory(ctx, deepseekTranslator, scraped, categoryTree);
      ctx.categoryTree = categoryTree;

      let requiredAttributes: Awaited<ReturnType<OzonClient["getCategoryAttributes"]>> = [];
      if (category.categoryId > 0) {
        // Try multiple category ID strategies for attribute lookup:
        // 1. attributeCategoryId (level-3 ancestor found by findAttributeCategoryId)
        // 2. The matched category's own ID (works for leaf categories)
        // 3. Level-2 ancestor as last resort
        const candidateIds = [
          category.attributeCategoryId,
          category.categoryId,
          ...(ctx.categoryTree ? [findNearestAncestorWithAttributes(ctx.categoryTree, category.categoryId)] : []),
        ].filter((id): id is number => id !== null && id !== undefined && id > 0);

        for (const attrId of [...new Set(candidateIds)]) {
          try {
            requiredAttributes = await ozonClient.getCategoryAttributes(attrId);
            if (requiredAttributes.length > 0) break; // success
          } catch {
            // try next candidate
          }
        }
      }
      if (requiredAttributes.length > 0) {
        await stepFillAttributes(ctx, deepseekTranslator, translated, category.categoryId, requiredAttributes);
      }

      // Download + upload images
      const allDetailImages = scraped.detailImages ?? [];
      await stepDownloadAndUploadImages(ctx, ozonClient, scraper, scraped.specImages, allDetailImages);

      const processed = buildProcessedProduct(ctx, {
        exchangeRate: (await getExchangeRate()).rate, defaultLength: 20, defaultWidth: 15, defaultHeight: 5, defaultWeight: 0.5,
      });
      ctx.processed = processed;

      const validation = validator.validate(processed);
      if (!validation.valid) {
        res.status(422).json({ success: false, error: { code: "VALIDATION_FAILED", message: "Validation failed", retryable: false }, details: validation.errors, correlationId: req.correlationId });
        return;
      }

      // Compliance check
      const compliance = fullComplianceCheck({
        categoryId: processed.categoryId,
        categoryName: processed.categoryName,
        categoryPath: processed.categoryPath,
        titleRu: processed.titleRu,
        descriptionRu: processed.descriptionRu,
      });
      if (compliance.blocked) {
        res.status(422).json({
          success: false,
          error: { code: "COMPLIANCE_BLOCKED", message: compliance.blockedReason ?? "Category prohibited", retryable: false },
          warnings: compliance.warnings,
          correlationId: req.correlationId,
        });
        return;
      }

      // Ops-agent review before publishing to Ozon
      const review = await stepOpsReview(ctx, processed);
      if (!review.approved) {
        logger.warn({ taskId: ctx.taskId, reason: review.reason }, "Ops-agent rejected listing");
        return;
      }
      if (review.riskLevel === "high") {
        logger.warn({ taskId: ctx.taskId, suggestions: review.suggestions }, "Ops-agent high risk — proceeding with caution");
      }

      const draftResult = await stepCreateDraft(ctx, ozonClient, processed);

      await recordPipelineSuccess(ctx);

      res.json({
        success: true,
        data: { taskId: ctx.taskId, draftId: draftResult.offerId, ozonProductId: draftResult.productId, titleRu: processed.titleRu, categoryName: processed.categoryName, priceRub: processed.priceRub, imagesUploaded: processed.specImageUrls.length, complianceWarnings: compliance.warnings.length > 0 ? compliance.warnings : undefined },
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

  // GET /api/debug/scraper-metrics — scraper monitoring
  router.get("/debug/scraper-metrics", (_req, res) => {
    res.json({ success: true, data: scraper.getMetrics(), correlationId: _req.correlationId });
  });

  return router;
}
