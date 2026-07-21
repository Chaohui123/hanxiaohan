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
  // Inject RAG v2 Top5 similar products for better category matching
  let ragContext: string | undefined;
  const isTest = (process.env.ENV || process.env.NODE_ENV) === "test" || process.env.VITEST === "true";
  const ragEnabled = process.env.RAG_ENABLE !== "false" && process.env.RAG_ENABLE !== "0";
  if (!isTest && ragEnabled) {
    try {
      const { RagV2Service } = await import("../services/rag-v2/service.js");
      const { getDb } = await import("../db/connection.js");
      const db = await getDb().catch(() => null);
      if (db) {
        const ragService = new RagV2Service(db);
        await ragService.init();
        ragContext = await ragService.searchForPrompt({
          collection: "success_copy",
          query: `${scraped.title} ${scraped.categoryPath?.join(" ") || ""}`,
          topK: 5,
        });
        if (ragContext) {
          logger.info({ taskId: ctx.taskId }, "RAG v2: injected Top5 context into category matching");
        }
      }
    } catch { /* RAG unavailable — continue without enrichment */ }
  }

  try {
    const match = await textClient.matchCategory(
      {
        title: scraped.title,
        categoryPath: scraped.categoryPath,
        specifications: scraped.specifications,
      },
      categoryTree,
      ragContext
    );
    const attributeCategoryId = findAttributeCategoryId(categoryTree, match.categoryId);

    // Block-level check: if categoryId is still 0 after retry, log fatal error
    if (match.categoryId <= 0) {
      const msg = `Category matching returned invalid ID (0) after retry — blocking pipeline`;
      ctx.errors.push({ step: "category", message: msg });
      throw new Error(msg);
    }

    ctx.category = { ...match!, attributeCategoryId: attributeCategoryId ?? undefined };
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
  _ozonClient: OzonClient, // kept for call-site compatibility; Ozon now fetches image URLs server-side
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

  // Ozon's pre-upload endpoints are all dead:
  //   - upload.ozon.ru → NXDOMAIN (retired)
  //   - POST /v1/picture/upload → 404
  //   - POST /v1/product/pictures/import → now requires product_id
  // v3/product/import (createDraft) accepts public image URLs directly and
  // Ozon fetches them server-side. Strategy:
  //   1. Public http(s) URLs (1688 CDN, COS) → passed straight to createDraft
  //   2. Non-public / browser-downloaded local images → mirrored to Tencent COS
  const finalUrls: string[] = [];
  const toMirror: string[] = [];

  for (const u of allImages) {
    if (/^https?:\/\/\S+$/i.test(u) && !/localhost|127\.0\.0\.1/.test(u)) {
      finalUrls.push(u);
    } else {
      toMirror.push(u);
    }
  }

  // Mirror non-public images to COS so they get fetchable public URLs
  if (toMirror.length > 0) {
    logger.info({ direct: finalUrls.length, toMirror: toMirror.length }, "Images — mirroring non-public images to COS");
    try {
      const downloaded = await scraper.downloadImagesViaBrowser(toMirror, { maxImages: toMirror.length });
      if (downloaded.length > 0) {
        const { CosUploader } = await import("../services/cos-uploader.js");
        const { getDb } = await import("../db/connection.js");
        const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
        const db = await getDb().catch(() => null);
        const cos = new CosUploader(db as never);

        for (const img of downloaded) {
          try {
            const ext = img.contentType.includes("png") ? "png"
              : img.contentType.includes("webp") ? "webp"
              : img.contentType.includes("gif") ? "gif"
              : "jpg";
            const fileName = `product-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
            const tmpDir = "./data/tmp-images";
            if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
            const filePath = `${tmpDir}/${fileName}`;
            writeFileSync(filePath, img.buffer);

            const result = await cos.uploadImage(filePath, ctx.taskId ?? "listing");
            if (result.success && result.url) {
              finalUrls.push(result.url);
              logger.debug({ fileName, cosUrl: result.url }, "Local image → COS success");
            } else {
              logger.warn({ imgUrl: img.url }, "COS upload returned failure — image skipped");
            }
          } catch (mirrorErr) {
            logger.warn({ imgUrl: img.url, err: (mirrorErr as Error).message }, "COS mirror failed");
          }
        }
      }
    } catch (downloadErr) {
      logger.warn({ err: (downloadErr as Error).message }, "Browser image download batch failed");
    }
  }

  if (finalUrls.length === 0) {
    const msg = "No usable product images — no public URLs available and COS mirror produced nothing";
    ctx.errors.push({ step: "upload_images", message: msg });
    throw new Error(msg);
  }

  // Warn if image count is below Ozon's recommended minimum (3+ images)
  if (finalUrls.length < 3) {
    const msg = `Only ${finalUrls.length} image(s) available (${allImages.length} candidates). Ozon recommends 3+ images per product.`;
    ctx.errors.push({ step: "upload_images", message: msg });
    logger.warn({ imageCount: finalUrls.length, candidates: allImages.length }, msg);
  }

  ctx.imageIds = finalUrls;
  logger.info({ usable: finalUrls.length, total: allImages.length }, "Images — URL set ready (Ozon fetches server-side at draft creation)");
  return finalUrls;
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

// ---- Step: Ops Review — send to ops-agent for automated safety/compliance judgment ----

export interface OpsReviewResult {
  approved: boolean;
  reason?: string;
  riskLevel: "low" | "medium" | "high";
  suggestions: string[];
}

/**
 * Call ops-agent for automated review before publishing to Ozon.
 * Ops-agent checks: category compliance, price sanity, image count, restricted keywords.
 */
export async function stepOpsReview(
  ctx: PipelineContext,
  processed: ProcessedProduct,
): Promise<OpsReviewResult> {
  try {
    const opsApiBase = process.env.OPS_AGENT_API || "http://ops-agent:8181";
    const resp = await fetch(`${opsApiBase}/api/review/listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: ctx.taskId,
        sourceUrl: ctx.sourceUrl,
        titleRu: processed.titleRu,
        descriptionRu: processed.descriptionRu,
        categoryId: processed.categoryId,
        categoryName: ctx.category?.categoryName || "",
        priceRub: processed.priceRub,
        imageCount: ctx.imageIds?.length ?? 0,
        specifications: processed.specificationsRu || [],
        weightKg: processed.weightKg,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      logger.warn({ taskId: ctx.taskId, status: resp.status },
        "Ops-agent review unavailable — allowing listing");
      return { approved: true, riskLevel: "low", suggestions: [] };
    }

    const result = (await resp.json()) as OpsReviewResult;
    logger.info({ taskId: ctx.taskId, ...result }, "Ops-agent review result");
    return result;
  } catch {
    // Ops-agent unreachable — allow listing (fail open)
    logger.info({ taskId: ctx.taskId }, "Ops-agent unreachable — auto-approving");
    return { approved: true, riskLevel: "low", suggestions: [] };
  }
}

export async function stepCreateDraft(
  ctx: PipelineContext,
  ozonClient: OzonClient,
  processed: ProcessedProduct
): Promise<{ productId: number; offerId: string }> {
  try {
    // Resolve type_id from category tree leaf nodes.
    // DO NOT fall back to categoryId — type_id is a different concept.
    const resolvedTypeId = processed.categoryTypeId
      || (ctx.categoryTree ? findLeafTypeId(ctx.categoryTree, processed.categoryId) : null)
      || null; // null = Ozon will auto-select type_id

    const draftInput = {
      name: processed.titleRu,
      description: processed.descriptionRu,
      categoryId: processed.categoryId,
      typeId: resolvedTypeId ?? undefined,
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

  // RAG v2 auto-index: successful listing → vector store for future matching
  const isTest = (process.env.ENV || process.env.NODE_ENV) === "test" || process.env.VITEST === "true";
  if (!isTest && process.env.RAG_ENABLE !== "false" && process.env.RAG_ENABLE !== "0") {
    try {
      const { RagV2Service } = await import("../services/rag-v2/service.js");
      const { getDb } = await import("../db/connection.js");
      const db = await getDb().catch(() => null);
      if (db) {
        const ragService = new RagV2Service(db);
        await ragService.init();
        await ragService.onListingSuccess(
          ctx.taskId,
          ctx.translated?.titleRu || "",
          ctx.translated?.descriptionRu || "",
          ctx.sourceUrl,
          ctx.category?.categoryId
        );
      }
    } catch { /* RAG unavailable — non-blocking */ }
  }

  // SKU-1688 mapping: auto-bind after successful listing
  if (ctx.translated && ctx.processed) {
    try {
      const { getDb } = await import("../db/connection.js");
      const { SkuMappingService } = await import("../services/sku-mapping.js");
      const db = await getDb().catch(() => null);
      if (db) {
        const skuService = new SkuMappingService(db);
        // Use the first product SKU from the listing
        const ozonSku = ctx.ozonProductId || 0;
        await skuService.bind({
          storeId: ctx.storeId || "store_1",
          ozonOfferId: ctx.draftId || `draft_${ctx.taskId}`,
          ozonSku,
          source1688Url: ctx.sourceUrl,
          purchasePriceCny: ctx.processed?.priceRub
            ? (await (await import("../services/exchange-rate.js")).getExchangeRate().then(r => ctx.processed!.priceRub / r.rate, () => ctx.processed!.priceRub / 11.5))
            : 0,
          weightKg: ctx.processed?.weightKg,
          supplierName: ctx.scraped?.supplier?.name || "",
          supplierPickupRate: ctx.scraped?.supplier?.pickupRate || 0,
        });
        logger.info({ taskId: ctx.taskId, offerId: ctx.draftId }, "SKU mapping: auto-bound after listing");
      }
    } catch { /* SKU mapping unavailable — non-blocking */ }
  }
}
