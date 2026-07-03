// ============================================================
// Listing Pipeline — Step-by-step 1688 → Ozon Draft
// Each step is independently testable
// ============================================================

import crypto from "node:crypto";
import type { ScrapedProduct, ProcessedProduct, TranslationResult, CategoryMatchResult, OzonCategoryNode, OzonAttribute } from "@onzo/shared-types";
import type { ProductScraper } from "@onzo/scraper-1688";
import type { GlmVisionClient } from "@onzo/glm-integration";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import type { DeepSeekTranslator } from "./deepseek-translator.js";
import type { AppConfig } from "../config.js";
import { saveFailedTask, saveListingRecord } from "../db/models.js";

// ---- Pipeline Context (accumulates state across steps) ----

export interface PipelineContext {
  taskId: string;
  correlationId: string;
  storeId: string;
  sourceUrl: string;
  // Accumulated data
  scraped?: ScrapedProduct;
  ocrTexts?: string[];
  translated?: TranslationResult;
  category?: CategoryMatchResult;
  attributes?: Array<{ attributeId: number; name: string; value: string | number | string[] }>;
  processed?: ProcessedProduct;
  imageIds?: string[];
  draftId?: string;
  ozonProductId?: number;
  errors: Array<{ step: string; message: string }>;
}

export function createPipelineContext(sourceUrl: string, storeId = "store_1"): PipelineContext {
  return {
    taskId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    storeId,
    sourceUrl,
    errors: [],
  };
}

// ---- Step Functions (each is a standalone export for unit testing) ----

export async function stepScrape(
  ctx: PipelineContext,
  scraper: ProductScraper,
  sourceUrl: string
): Promise<ScrapedProduct> {
  try {
    const product = await scraper.scrapeProduct(sourceUrl);
    ctx.scraped = product;
    return product;
  } catch (err) {
    const msg = `Scrape failed: ${(err as Error).message}`;
    ctx.errors.push({ step: "scrape", message: msg });
    throw err;
  }
}

export async function stepOcr(
  ctx: PipelineContext,
  visionClient: GlmVisionClient,
  specImages: string[]
): Promise<string[]> {
  try {
    const images = specImages.slice(0, 5).map((url: string) => ({ url }));
    const results = await visionClient.extractTextFromImages(images);
    const texts = results.map((r) => r.rawText).filter(Boolean);
    ctx.ocrTexts = texts;
    return texts;
  } catch (err) {
    const msg = `OCR failed: ${(err as Error).message}`;
    ctx.errors.push({ step: "ocr", message: msg });
    throw err;
  }
}

export async function stepTranslate(
  ctx: PipelineContext,
  textClient: DeepSeekTranslator,
  scraped: ScrapedProduct
): Promise<TranslationResult> {
  try {
    const translated = await textClient.translateProduct({
      title: scraped.title,
      description: scraped.descriptionText,
      specifications: scraped.specifications,
      ocrTexts: ctx.ocrTexts,
    });
    ctx.translated = translated;
    return translated;
  } catch (err) {
    const msg = `Translation failed: ${(err as Error).message}`;
    ctx.errors.push({ step: "translate", message: msg });
    throw err;
  }
}

export async function stepMatchCategory(
  ctx: PipelineContext,
  textClient: DeepSeekTranslator,
  scraped: ScrapedProduct,
  categoryTree: OzonCategoryNode[]
): Promise<CategoryMatchResult> {
  try {
    const match = await textClient.matchCategory(
      {
        title: scraped.title,
        categoryPath: scraped.categoryPath,
        specifications: scraped.specifications,
      },
      categoryTree
    );
    ctx.category = match;
    return match;
  } catch (err) {
    const msg = `Category matching failed: ${(err as Error).message}`;
    ctx.errors.push({ step: "category", message: msg });
    throw err;
  }
}

export async function stepFillAttributes(
  ctx: PipelineContext,
  textClient: DeepSeekTranslator,
  translated: TranslationResult,
  categoryId: number,
  requiredAttributes: OzonAttribute[]
): Promise<Array<{ attributeId: number; name: string; value: string | number | string[] }>> {
  try {
    if (requiredAttributes.length === 0) {
      ctx.attributes = [];
      return [];
    }

    const result = await textClient.fillAttributes(
      {
        titleRu: translated.titleRu,
        descriptionRu: translated.descriptionRu,
        specifications: translated.specificationsRu,
      },
      categoryId,
      requiredAttributes
    );
    ctx.attributes = result.attributes;
    return result.attributes;
  } catch (err) {
    const msg = `Attribute fill failed: ${(err as Error).message}`;
    ctx.errors.push({ step: "fill_attributes", message: msg });
    throw err;
  }
}

export async function stepUploadImages(
  ctx: PipelineContext,
  ozonClient: OzonClient,
  specImages: string[]
): Promise<string[]> {
  try {
    // Primary: import by URL (1688 image URLs → Ozon)
    const urlResults = await Promise.allSettled(
      specImages.slice(0, 15).map((imgUrl: string) => ozonClient.importImageByUrl(imgUrl))
    );

    const imageIds: string[] = [];
    for (const r of urlResults) {
      if (r.status === "fulfilled") imageIds.push(String(r.value.id));
    }

    if (imageIds.length === 0) {
      throw new Error("All image URL imports failed (likely hotlink-protected 1688 images)");
    }

    ctx.imageIds = imageIds;
    return imageIds;
  } catch (err) {
    const msg = `Image upload failed: ${(err as Error).message}`;
    ctx.errors.push({ step: "upload_images", message: msg });
    throw err;
  }
}

export async function stepCreateDraft(
  ctx: PipelineContext,
  ozonClient: OzonClient,
  processed: ProcessedProduct
): Promise<{ productId: number; offerId: string }> {
  try {
    const draftInput = {
      name: processed.titleRu,
      description: processed.descriptionRu,
      categoryId: processed.categoryId,
      price: processed.priceRub.toFixed(2),
      vat: "0" as const,
      images: processed.specImageUrls, // 1688 URLs — Ozon downloads directly
      attributes: processed.attributes.map((a) => ({
        id: a.attributeId,
        values: [{ value: a.value as string }],
      })),
      dimensions: {
        length: processed.dimensionsCm.length * 10,
        width: processed.dimensionsCm.width * 10,
        height: processed.dimensionsCm.height * 10,
        weight: processed.weightKg * 1000,
      },
    };

    const result = await ozonClient.createDraft(draftInput);
    ctx.draftId = result.offerId;
    ctx.ozonProductId = result.productId;
    return result;
  } catch (err) {
    const msg = `Draft creation failed: ${(err as Error).message}`;
    ctx.errors.push({ step: "create_draft", message: msg });
    throw err;
  }
}

/**
 * Helper: build ProcessedProduct from accumulated context.
 */
export function buildProcessedProduct(
  ctx: PipelineContext,
  opts: { exchangeRate: number; defaultLength: number; defaultWidth: number; defaultHeight: number; defaultWeight: number }
): ProcessedProduct {
  const scraped = ctx.scraped!;
  const priceRub = Math.round(scraped.price.currentMin * opts.exchangeRate * 1.3);

  return {
    sourceUrl: ctx.sourceUrl,
    titleCn: scraped.title,
    priceCny: { min: scraped.price.currentMin, max: scraped.price.currentMax },
    specImageUrls: scraped.specImages,
    detailImageUrls: scraped.detailImages,
    specificationsCn: scraped.specifications,
    ocrTexts: ctx.ocrTexts ?? [],
    titleRu: ctx.translated?.titleRu ?? scraped.title,
    descriptionRu: ctx.translated?.descriptionRu ?? scraped.descriptionText,
    specificationsRu: ctx.translated?.specificationsRu ?? [],
    categoryId: ctx.category?.categoryId ?? 0,
    categoryName: ctx.category?.categoryName ?? "",
    categoryPath: ctx.category?.categoryPath ?? [],
    attributes: ctx.attributes ?? [],
    priceRub,
    dimensionsCm: {
      length: opts.defaultLength,
      width: opts.defaultWidth,
      height: opts.defaultHeight,
    },
    weightKg: opts.defaultWeight,
    imageIds: ctx.imageIds ?? [],
  };
}

/**
 * Record pipeline failure to the failed_tasks table.
 */
export async function recordPipelineFailure(
  ctx: PipelineContext,
  error: Error
): Promise<void> {
  await saveFailedTask({
    id: ctx.taskId,
    storeId: ctx.storeId,
    taskType: "full_pipeline",
    payloadJson: JSON.stringify({ sourceUrl: ctx.sourceUrl }),
    errorMessage: error.message,
    status: "pending_retry",
    correlationId: ctx.correlationId,
  }).catch(() => {});
}

/**
 * Record pipeline success to the listing_records table.
 */
export async function recordPipelineSuccess(ctx: PipelineContext): Promise<void> {
  await saveListingRecord({
    id: ctx.taskId,
    sourceUrl: ctx.sourceUrl,
    status: "done",
    draftId: ctx.draftId,
    ozonProductId: ctx.ozonProductId,
    correlationId: ctx.correlationId,
    resultJson: JSON.stringify({
      titleRu: ctx.translated?.titleRu,
      categoryName: ctx.category?.categoryName,
      priceRub: ctx.processed?.priceRub,
      imageCount: ctx.imageIds?.length ?? 0,
    }),
  });
}
