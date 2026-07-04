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
import { heuristicFillAttributes, buildDefaultAttributes, type FilledAttribute } from "./attribute-filler.js";
import type { AppConfig } from "../config.js";
import { saveFailedTask, saveListingRecord } from "../db/models.js";
import { logger } from "@onzo/logger";

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
  categoryTree?: OzonCategoryNode[];
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
    const attributeCategoryId = findAttributeCategoryId(categoryTree, match.categoryId);

    // Block-level check: if categoryId is still 0 after retry, log fatal error
    if (match.categoryId <= 0) {
      const msg = `Category matching returned invalid ID (0) after retry — blocking pipeline`;
      ctx.errors.push({ step: "category", message: msg });
      throw new Error(msg);
    }

    ctx.category = { ...match, attributeCategoryId };
    return ctx.category;
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
  if (requiredAttributes.length === 0) {
    ctx.attributes = [];
    return [];
  }

  try {
    const result = await textClient.fillAttributes(
      {
        titleRu: translated.titleRu,
        descriptionRu: translated.descriptionRu,
        specifications: translated.specificationsRu,
      },
      categoryId,
      requiredAttributes
    );
    ctx.attributes = result.attributes.length > 0
      ? result.attributes
      : heuristicFillAttributes(translated.specificationsRu, requiredAttributes);
    return ctx.attributes as FilledAttribute[];
  } catch (err) {
    // DeepSeek failed — fall back to heuristic fill
    const msg = `Attribute fill failed: ${(err as Error).message} — using heuristic fallback`;
    ctx.errors.push({ step: "fill_attributes", message: msg });
    ctx.attributes = requiredAttributes.length > 0
      ? heuristicFillAttributes(translated.specificationsRu, requiredAttributes)
      : buildDefaultAttributes(
          { title: translated.titleRu, specifications: translated.specificationsRu },
          requiredAttributes
        );
    return ctx.attributes as FilledAttribute[];
  }
}

/**
 * Download images from 1688 (with referer to bypass hotlink protection)
 * and upload them to Ozon's CDN. Returns Ozon image IDs.
 *
 * Strategy:
 * 1. Try Ozon URL import first (fast path — Ozon downloads from URL)
 * 2. For failed URLs, download locally via scraper (with 1688 referer)
 * 3. Upload downloaded files to Ozon via file upload API
 */
export async function stepDownloadAndUploadImages(
  ctx: PipelineContext,
  ozonClient: OzonClient,
  scraper: ProductScraper,
  specImages: string[],
  detailImages: string[] = []
): Promise<string[]> {
  // 1. Filter: remove icons, SVGs, logos, tiny images — keep only product photos
  const rawImages = [...new Set([...specImages, ...detailImages])];
  const productImages = scraper.filterProductImages(rawImages);
  const allImages = productImages.slice(0, 15); // Ozon max 15
  if (allImages.length === 0) {
    throw new Error("No product images found after filtering — all images were icons/logos/SVGs");
  }

  logger.info({ filtered: allImages.length, raw: rawImages.length }, "Images — filtering complete");

  const imageIds: string[] = [];
  const failedUrls: string[] = [];

  // Phase 1: Try Ozon URL import (soft — failures don't trip circuit breaker)
  const urlResults = await Promise.allSettled(
    allImages.map((imgUrl: string) => ozonClient.importImageByUrlSoft(imgUrl))
  );

  for (let i = 0; i < urlResults.length; i++) {
    const r = urlResults[i];
    if (r.status === "fulfilled" && r.value !== null) {
      imageIds.push(String(r.value.id));
    } else {
      failedUrls.push(allImages[i]);
    }
  }

  // Reset Ozon circuit breaker — image operations shouldn't be blocked by earlier failures
  (ozonClient as { resetBreaker?: () => void }).resetBreaker?.();

  // Phase 2: Download via Playwright browser, save locally, import via Express URL
  if (failedUrls.length > 0) {
    logger.info({ urlImported: imageIds.length, toRetry: failedUrls.length }, "Images — URL import partial, trying browser download");

    try {
      const downloaded = await scraper.downloadImagesViaBrowser(failedUrls, { maxImages: failedUrls.length });

      for (const img of downloaded) {
        try {
          const ext = img.contentType.includes("png") ? "png"
            : img.contentType.includes("webp") ? "webp"
            : img.contentType.includes("gif") ? "gif"
            : "jpg";
          const fileName = `product-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

          // Save to temp directory served by Express at /tmp-images/
          const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
          const tmpDir = "./data/tmp-images";
          if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
          writeFileSync(`${tmpDir}/${fileName}`, img.buffer);

          // Import via local Express URL (Ozon only supports URL-based image import)
          const port = process.env.API_SERVICE_PORT || process.env.PORT || "3000";
          const localUrl = `http://localhost:${port}/tmp-images/${fileName}`;
          const result = await ozonClient.importImageByUrlSoft(localUrl);
          if (result) {
            imageIds.push(String(result.id));
            logger.debug({ fileName, imageId: result.id }, "Browser download → local file → Ozon import success");
          }
        } catch (uploadErr) {
          logger.warn({ imgUrl: img.url, err: (uploadErr as Error).message }, "Image pipeline failed");
        }
      }
    } catch (downloadErr) {
      logger.warn({ err: (downloadErr as Error).message }, "Browser image download batch failed");
    }
  }

  // Phase 3: Last resort — direct fetch (works for non-hotlink-protected URLs)
  if (imageIds.length === 0 && failedUrls.length > 0) {
    logger.warn("Images — browser download also failed, trying direct fetch as last resort");
    try {
      const downloaded = await scraper.downloadImages(failedUrls.slice(0, 5), 2);
      for (const img of downloaded) {
        try {
          const base64 = img.buffer.toString("base64");
          const ext = img.contentType.includes("png") ? "png" : "jpg";
          const result = await ozonClient.uploadLocalImageFile(
            `product-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`, base64
          );
          imageIds.push(String(result.id));
        } catch { /* exhausted */ }
      }
    } catch { /* all methods exhausted */ }
  }

  if (imageIds.length === 0) {
    const msg = "All image uploads failed — URL import, browser download, and direct fetch all exhausted";
    ctx.errors.push({ step: "upload_images", message: msg });
    throw new Error(msg);
  }

  // Warn if image count is below Ozon's recommended minimum (3+ images)
  if (imageIds.length < 3) {
    const msg = `Only ${imageIds.length} image(s) uploaded (${allImages.length} attempted). Ozon recommends 3+ images per product.`;
    ctx.errors.push({ step: "upload_images", message: msg });
    logger.warn({ imageCount: imageIds.length, attempted: allImages.length }, msg);
  }

  ctx.imageIds = imageIds;
  logger.info({ uploaded: imageIds.length, total: allImages.length }, "Images — upload complete");
  return imageIds;
}

/** @deprecated Use stepDownloadAndUploadImages instead */
export async function stepUploadImages(
  ctx: PipelineContext,
  ozonClient: OzonClient,
  specImages: string[]
): Promise<string[]> {
  // Legacy wrapper — delegates to new method but without scraper for local fallback
  try {
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
    // Resolve type_id from the category tree (leaf nodes have type_id for product/import)
    const resolvedTypeId = processed.categoryTypeId
      || (ctx.categoryTree ? findLeafTypeId(ctx.categoryTree, processed.categoryId) : null)
      || processed.categoryId;

    const draftInput = {
      name: processed.titleRu,
      description: processed.descriptionRu,
      categoryId: processed.categoryId,
      typeId: resolvedTypeId,
      price: processed.priceRub,
      vat: "0" as const,
      images: ctx.imageIds ?? processed.specImageUrls, // Ozon image IDs (primary) or raw URLs (fallback)
      attributes: (processed.attributes ?? []).map((a) => ({
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
  // Base price = CNY cost × FX rate × 1.3 markup (matches price-monitor scorer logic)
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
/**
 * Find the nearest ancestor category that can accept attribute queries.
 * Walks UP the tree from the target to find a non-leaf category.
 */
export function findNearestAncestorWithAttributes(
  nodes: OzonCategoryNode[],
  targetCategoryId: number
): number | null {
  const path = findCategoryPath(nodes, targetCategoryId);
  if (!path || path.length === 0) return null;

  // Walk backward from the target, return the first ancestor that has children
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].children?.length > 0 || path[i].typeId) {
      return path[i].categoryId;
    }
  }
  return path[path.length - 1].categoryId;
}

/** Find the 3rd-level category ID for attribute lookup.
 * When a leaf category is 4 levels deep, return its level-3 ancestor.
 * Otherwise return the selected leaf category itself.
 */
export function findAttributeCategoryId(
  nodes: OzonCategoryNode[],
  targetCategoryId: number
): number | null {
  const path = findCategoryPath(nodes, targetCategoryId);
  if (!path) return null;
  return path.length >= 3 ? path[2].categoryId : path[path.length - 1].categoryId;
}

/** Recursively find the leaf type_id for a description_category_id. */
export function findLeafTypeId(
  nodes: OzonCategoryNode[],
  targetCategoryId: number
): number | null {
  for (const node of nodes) {
    if (node.categoryId === targetCategoryId) {
      if (node.typeId) return node.typeId;
      for (const child of node.children) {
        const found = findLeafTypeId([child], child.categoryId);
        if (found) return found;
      }
    }
    if (node.children.length > 0) {
      const found = findLeafTypeId(node.children, targetCategoryId);
      if (found) return found;
    }
  }
  return null;
}

function findCategoryPath(
  nodes: OzonCategoryNode[],
  targetCategoryId: number,
  currentPath: OzonCategoryNode[] = []
): OzonCategoryNode[] | null {
  for (const node of nodes) {
    const nextPath = [...currentPath, node];
    if (node.categoryId === targetCategoryId) {
      return nextPath;
    }
    if (node.children.length > 0) {
      const found = findCategoryPath(node.children, targetCategoryId, nextPath);
      if (found) return found;
    }
  }
  return null;
}

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
