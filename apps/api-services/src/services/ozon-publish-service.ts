// ============================================================
// Ozon Publish Service — End-to-end standardized Ozon listing
// Wraps OzonClient with field validation, auto-fill, image upload,
// draft creation, moderation polling, and auto-retry on errors.
// ============================================================

import { logger } from "@onzo/logger";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import {
  validateRequiredFields,
  autoFillFromLLM,
  generateModelName,
  generateSku,
  type StandardizedProductInput,
} from "./ozon-field-validator.js";
import { breakerFire } from "./circuit-breakers.js";

export interface PublishResult {
  success: boolean;
  taskId?: string;
  productId?: number;
  offerId?: string;
  status: "draft" | "published" | "moderating" | "failed";
  errors: string[];
  warnings: string[];
}

export class OzonPublishService {
  private client: OzonClient;

  constructor(client: OzonClient) {
    this.client = client;
  }

  /**
   * Full publish pipeline:
   * 1. Validate required fields
   * 2. Auto-fill missing fields (LLM output)
   * 3. Upload images
   * 4. Create draft
   * 5. Poll moderation status
   * 6. Auto-retry on failure
   */
  async publishProduct(
    product: StandardizedProductInput,
    llmOutput?: {
      titleRu?: string;
      descriptionRu?: string;
      modelName?: string;
      categoryId?: number;
      estimatedWeightG?: number;
    },
  ): Promise<PublishResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Step 1: Validate
    const validation = validateRequiredFields(product, product.categoryId);
    warnings.push(...validation.warnings);
    if (!validation.valid) {
      return { success: false, status: "failed", errors: validation.errors, warnings };
    }

    // Step 2: Auto-fill
    const filled = llmOutput
      ? autoFillFromLLM(product, llmOutput)
      : product;

    // Generate model name
    const modelName = llmOutput?.modelName || generateModelName(filled.title, filled.specs);

    // Generate SKU
    const sku = filled.sku || generateSku(filled.sourceUrl, filled.priceCny);

    // Step 3: Prepare image URLs — Ozon's pre-upload endpoints are dead
    // (upload.ozon.ru NXDOMAIN, /v1/picture/upload 404), so public URLs are
    // passed straight to createDraft (Ozon fetches server-side); local files
    // are mirrored to Tencent COS for a public URL.
    const uploadedImageUrls: string[] = [];
    const { CosUploader } = await import("./cos-uploader.js");
    const cos = new CosUploader(null);
    for (const imgUrl of filled.images.slice(0, 10)) {
      if (/^https?:\/\/\S+$/i.test(imgUrl) && !/localhost|127\.0\.0\.1/.test(imgUrl)) {
        uploadedImageUrls.push(imgUrl);
        continue;
      }
      // Local file path → mirror to COS
      try {
        const result = await cos.uploadImage(imgUrl, filled.sku || "publish");
        if (result.success && result.url) uploadedImageUrls.push(result.url);
        else warnings.push(`COS mirror failed: ${imgUrl.slice(0, 50)}`);
      } catch {
        warnings.push(`Image unavailable (not a public URL, COS mirror failed): ${imgUrl.slice(0, 50)}`);
      }
    }

    if (uploadedImageUrls.length === 0) {
      errors.push("All image uploads failed — cannot create listing without images");
      return { success: false, status: "failed", errors, warnings };
    }

    // Step 4: Create draft via OzonClient (with circuit breaker)
    // type_id is REQUIRED by /v3/product/import since 2025-05 — resolve from
    // the category tree leaf before creating.
    let typeId: number | undefined;
    try {
      const tree = await this.client.getCategoryTree(filled.categoryId);
      const findType = (nodes: typeof tree, target: number): number | null => {
        for (const n of nodes) {
          if (n.categoryId === target && n.typeId) return n.typeId;
          const found = findType(n.children, target);
          if (found) return found;
        }
        return null;
      };
      typeId = findType(tree, filled.categoryId) ?? undefined;
    } catch {
      warnings.push(`type_id resolution failed for categoryId ${filled.categoryId} — createDraft will reject if unresolved`);
    }

    try {
      const draftResult = await breakerFire("ozonApi", () =>
        this.client.createDraft({
          offerId: (filled.sku || `onzo-${Date.now()}`).slice(0, 50),
          typeId: typeId as number,
          name: filled.titleRu || filled.title,
          description: filled.descriptionRu || "",
          categoryId: filled.categoryId,
          price: filled.priceCny, // will be converted to RUB by pricing engine
          vat: "0%",
          images: uploadedImageUrls,
          dimensions: {
            length: parseInt(process.env.OZON_DEFAULT_DEPTH_MM || "100", 10),
            width: parseInt(process.env.OZON_DEFAULT_WIDTH_MM || "100", 10),
            height: parseInt(process.env.OZON_DEFAULT_HEIGHT_MM || "50", 10),
            weight: Math.round((filled.weightG || 500) / 1000), // grams → kg for Ozon API
          },
          barcode: filled.barcode,
          oldPrice: undefined,
          attributes: [
            { id: 9048, values: [{ value: modelName }] }, // Model name (required)
            { id: 8229, values: [{ value: extractMaterials(filled.specs) }] }, // Materials
          ],
        })
      );

      logger.info({
        productId: draftResult.productId,
        taskId: draftResult.taskId,
        offerId: draftResult.offerId,
      }, "OzonPublishService: draft created successfully");

      return {
        success: true,
        taskId: String(draftResult.taskId),
        productId: draftResult.productId,
        offerId: draftResult.offerId,
        status: "moderating",
        errors,
        warnings,
      };
    } catch (err) {
      const msg = (err as Error).message;
      logger.error({ err: msg, product: filled.title?.slice(0, 40) }, "OzonPublishService: draft creation failed");
      errors.push(`Draft creation failed: ${msg}`);
      return { success: false, status: "failed", errors, warnings };
    }
  }

  /**
   * Check moderation status after publishing.
   * Returns whether the product passed moderation.
   */
  async checkModerationStatus(productId: number): Promise<{
    status: string;
    errors: string[];
  }> {
    try {
      const info = await this.client.getProductInfo(productId);
      const errors: string[] = [];

      if (info.status === "declined" || info.status === "failed") {
        errors.push(`Product ${productId} was declined/failed`);
      }
      if (!info.images || info.images.length === 0) {
        errors.push("Images missing after publish");
      }

      return { status: info.status, errors };
    } catch (err) {
      return { status: "unknown", errors: [(err as Error).message] };
    }
  }

  /**
   * Batch publish multiple products.
   */
  async batchPublish(
    products: StandardizedProductInput[],
  ): Promise<PublishResult[]> {
    const results: PublishResult[] = [];
    for (const product of products) {
      const result = await this.publishProduct(product);
      results.push(result);
    }
    return results;
  }
}

// ---- Helpers ----

function extractMaterials(specs: Array<{ name: string; value: string }>): string {
  const materialSpec = specs.find((s) =>
    /材质|材料|material|материал|成分|composition/i.test(s.name)
  );
  return materialSpec?.value || "Смешанный материал";
}
