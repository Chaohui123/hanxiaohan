#!/usr/bin/env npx tsx
// ============================================================
// ONZO Pipeline Interactive Validator
// Usage: npx tsx scripts/validate-pipeline.ts <1688_URL> [--dry-run]
// Steps through each pipeline stage and reports results.
// ============================================================

import "dotenv/config";
import { createPipelineContext, stepScrape, stepOcr, stepTranslate, stepMatchCategory, stepFillAttributes, stepDownloadAndUploadImages, stepCreateDraft, buildProcessedProduct } from "../apps/api-services/src/pipelines/listing-pipeline.js";
import { ProductScraper, BrowserPool } from "../packages/scraper/src/index.js";
import { GlmVisionClient, DeepSeekClient, GlmRateLimiter, TokenTracker } from "../packages/ai/src/index.js";
import { DeepSeekTranslator } from "../apps/api-services/src/pipelines/deepseek-translator.js";
import { OzonClient, AuthManager } from "../packages/ozon-api-wrapper/src/index.js";
import { getCategoryTree } from "../apps/api-services/src/services/category-cache.js";
import { getExchangeRate } from "../apps/api-services/src/services/exchange-rate.js";
import { ProductValidator } from "../packages/validator/src/index.js";
import { fullComplianceCheck } from "../apps/api-services/src/services/compliance.js";

// ---- Config ----
const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http"));
const dryRun = args.includes("--dry-run");

if (!url) {
  console.log("Usage: npx tsx scripts/validate-pipeline.ts <1688_URL> [--dry-run]");
  console.log("  --dry-run: Skip Ozon draft creation");
  process.exit(1);
}

const STEP_DELAY_MS = 2000; // Pause between steps for readability

async function pause(step: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`STEP: ${step}`);
  console.log(`${"=".repeat(60)}`);
  await new Promise((r) => setTimeout(r, STEP_DELAY_MS));
}

function result(ok: boolean, detail: string) {
  console.log(`  ${ok ? "✅" : "❌"} ${detail}`);
}

// ---- Main ----
async function main() {
  console.log("ONZO Pipeline Validator");
  console.log(`  URL: ${url}`);
  console.log(`  Mode: ${dryRun ? "DRY RUN (no Ozon API)" : "LIVE"}`);
  console.log("");

  const ctx = createPipelineContext(url);
  const browserPool = new BrowserPool({ maxBrowsers: 2 });
  const scraper = new ProductScraper({ headless: true, minDelayMs: 3000, maxDelayMs: 5000 });
  const validator = new ProductValidator();
  const tokenTracker = new TokenTracker({ dailyLimit: parseInt(process.env.LLM_DAILY_TOKEN_LIMIT || "500000", 10) });
  const glmLimiter = new GlmRateLimiter({ maxConcurrent: 5, tokensPerMinute: 60 });

  const visionClient = new GlmVisionClient({ apiKey: process.env.GLM_API_KEY || "", baseUrl: `${process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4"}/chat/completions`, model: "glm-4.6v-flash", tokenTracker });
  const deepseekClient = new DeepSeekClient({ apiKey: process.env.DEEPSEEK_API_KEY || "", baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1", flashModel: "deepseek-v4-flash", proModel: "deepseek-v4-pro", tokenTracker });
  const translator = new DeepSeekTranslator(deepseekClient);

  const ozonClient = new OzonClient({
    auth: new AuthManager({ clients: [{ clientId: process.env.OZON_CLIENT_IDS || "", apiKey: process.env.OZON_API_KEYS || "" }] }),
    baseUrl: process.env.OZON_API_BASE || "https://api-seller.ozon.ru",
  });

  try {
    // Step 1: Scrape
    await pause("Step 1: Scrape 1688 Product");
    await browserPool.acquire();
    let scraped;
    try {
      scraped = await stepScrape(ctx, scraper, url);
      result(true, `Title: ${scraped.title}`);
      result(true, `Price: ${scraped.price.currentMin} - ${scraped.price.currentMax} CNY`);
      result(true, `Images: ${scraped.specImages.length} spec + ${(scraped.detailImages || []).length} detail`);
    } catch (err) {
      result(false, `Scrape failed: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      browserPool.release();
    }

    // Step 2: OCR
    await pause("Step 2: OCR (GLM Vision)");
    try {
      const ocrTexts = await glmLimiter.call(() => stepOcr(ctx, visionClient, scraped.specImages.slice(0, 5)));
      result(true, `Extracted ${ocrTexts.length} text segments`);
      if (ocrTexts.length > 0) result(true, `Sample: ${ocrTexts[0].substring(0, 80)}...`);
    } catch (err) {
      result(false, `OCR failed: ${(err as Error).message}`);
    }

    // Step 3: Translate
    await pause("Step 3: Translate (DeepSeek)");
    try {
      const translated = await glmLimiter.call(() => stepTranslate(ctx, translator, scraped));
      result(true, `RU Title: ${translated.titleRu}`);
      result(true, `RU Desc: ${translated.descriptionRu.substring(0, 80)}...`);
    } catch (err) {
      result(false, `Translate failed: ${(err as Error).message}`);
      process.exit(1);
    }

    // Step 4: Category Match
    await pause("Step 4: Category Match (DeepSeek + Ozon Tree)");
    try {
      const categoryTree = await getCategoryTree(ozonClient, { ttlHours: 24 });
      result(true, `Category tree loaded (${categoryTree.length} root categories)`);
      const category = await stepMatchCategory(ctx, translator, scraped, categoryTree);
      result(true, `Category: [${category.categoryId}] ${category.categoryName}`);
      result(true, `Path: ${category.categoryPath.join(" > ")}`);
      result(true, `Confidence: ${(category.confidence * 100).toFixed(0)}%`);
    } catch (err) {
      result(false, `Category match failed: ${(err as Error).message}`);
    }

    // Step 5: Fill Attributes
    await pause("Step 5: Fill Attributes");
    if (ctx.category && ctx.category.categoryId > 0) {
      try {
        const requiredAttrs = await ozonClient.getCategoryAttributes(ctx.category.categoryId).catch(() => []);
        if (requiredAttrs.length > 0) {
          const attrs = await stepFillAttributes(ctx, translator, ctx.translated!, ctx.category.categoryId, requiredAttrs);
          result(true, `Filled ${attrs.length}/${requiredAttrs.length} required attributes`);
          for (const a of attrs.slice(0, 5)) {
            result(true, `  ${a.name} = ${a.value}`);
          }
        } else {
          result(true, "No required attributes for this category");
        }
      } catch (err) {
        result(false, `Attribute fill failed: ${(err as Error).message}`);
      }
    }

    // Step 6: Images
    await pause("Step 6: Image Processing");
    try {
      const images = await stepDownloadAndUploadImages(ctx, ozonClient, scraper, scraped.specImages, scraped.detailImages || []);
      result(true, `${images.length} images ready for Ozon`);
    } catch (err) {
      result(false, `Image processing failed: ${(err as Error).message}`);
    }

    // Step 7: Build + validate
    await pause("Step 7: Build Product + Validate");
    const fx = await getExchangeRate();
    result(true, `Exchange rate: ${fx.rate} RUB/CNY (${fx.reliable ? "reliable" : "UNRELIABLE"})`);

    const processed = buildProcessedProduct(ctx, { exchangeRate: fx.rate, defaultLength: 20, defaultWidth: 15, defaultHeight: 5, defaultWeight: 0.5 });
    result(true, `Title RU: ${processed.titleRu}`);
    result(true, `Price: ${processed.priceRub} RUB`);
    result(true, `Category: ${processed.categoryId} ${processed.categoryName}`);

    const validation = validator.validate(processed);
    if (validation.valid) {
      result(true, `Validation passed (${validation.stats.passed}/${validation.stats.totalChecks} checks)`);
    } else {
      for (const e of validation.errors) {
        result(false, `${e.field}: ${e.message}`);
      }
    }
    for (const w of validation.warnings) {
      result(true, `⚠️  ${w.field}: ${w.message}`);
    }

    const compliance = fullComplianceCheck({
      categoryId: processed.categoryId,
      categoryName: processed.categoryName,
      categoryPath: processed.categoryPath,
      titleRu: processed.titleRu,
      descriptionRu: processed.descriptionRu,
    });
    result(!compliance.blocked, compliance.blocked ? `BLOCKED: ${compliance.blockedReason}` : "Compliance check passed");

    // Step 8: Create Draft (skip in dry-run)
    await pause(`Step 8: Create Ozon Draft ${dryRun ? "(SKIPPED — dry-run)" : ""}`);
    if (!dryRun) {
      try {
        const draft = await stepCreateDraft(ctx, ozonClient, processed);
        result(true, `DRAFT CREATED!`);
        result(true, `  Product ID: ${draft.productId}`);
        result(true, `  Offer ID: ${draft.offerId}`);
        result(true, `  Status: ${draft.status}`);
        console.log(`\n  Ozon link: https://seller.ozon.ru/app/products/${draft.productId}`);
      } catch (err) {
        result(false, `Draft creation failed: ${(err as Error).message}`);
      }
    }

    // Summary
    console.log(`\n${"=".repeat(60)}`);
    console.log("PIPELINE COMPLETE");
    console.log(`${"=".repeat(60)}`);
    if (ctx.errors.length > 0) {
      console.log(`Warnings (${ctx.errors.length}):`);
      for (const e of ctx.errors) {
        console.log(`  [${e.step}] ${e.message}`);
      }
    }
    console.log(`Task ID: ${ctx.taskId}`);
    console.log(`Correlation ID: ${ctx.correlationId}`);

  } finally {
    await scraper.close();
    console.log("\nScraper closed.");
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
