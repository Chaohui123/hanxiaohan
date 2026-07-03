// ============================================================
// OzonClient — Main API client with resilience patterns
// ============================================================

import type {
  OzonDraftInput,
  OzonDraftResult,
  OzonImageUploadResult,
  OzonCategoryNode,
  OzonAttribute,
  OzonProductInfo,
} from "@onzo/shared-types";

/** Raw API response item shapes */
interface OzonProductInfoApi { id: number; offer_id: string; name: string; status: string; images: string[]; category_id: number; price: string; commissions?: { sales_percent_fbo?: number } }
interface OzonCategoryApi { category_id: number; title: string; children?: OzonCategoryApi[] }
interface OzonAttributeApi { id: number; name: string; description: string; type: string; is_required: boolean; is_collection: boolean; dictionary?: Array<{ id: number; value: string }> }
interface OzonUploadApi { id: number | string; file_name?: string; url?: string }

import { AuthManager } from "./auth.js";
import { RateLimiter, type RateLimiterConfig } from "./rate-limiter.js";
import { RetryPolicy, type RetryConfig } from "./retry.js";
import { CircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.js";
import {
  RateLimitError,
  ServerError,
  FatalError,
  ValidationError,
  AuthError,
  NetworkError,
} from "./errors.js";

const OZON_BASE_URL = "https://api-seller.ozon.ru";

export interface OzonClientConfig {
  auth: AuthManager;
  rateLimiterConfig?: Partial<RateLimiterConfig>;
  retryConfig?: Partial<RetryConfig>;
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>;
  baseUrl?: string;
  timeout?: number;
  storeId?: string;
}

export class OzonClient {
  private auth: AuthManager;
  private rateLimiter: RateLimiter;
  private retry: RetryPolicy;
  private circuitBreaker: CircuitBreaker;
  private baseUrl: string;
  private timeout: number;
  private storeId?: string;

  constructor(config: OzonClientConfig) {
    this.auth = config.auth;
    this.rateLimiter = new RateLimiter({
      tokensPerInterval: 30,
      intervalMs: 60000,
      maxBurst: 20,
      ...config.rateLimiterConfig,
    });
    this.retry = new RetryPolicy(config.retryConfig);
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      openTimeoutMs: 30000,
      ...config.circuitBreakerConfig,
      monitor: config.circuitBreakerConfig?.monitor ?? ((event) => {
        if (event.type === "OPEN" || event.type === "CLOSE") {
          console.warn(`[CircuitBreaker] State changed to ${event.type}`, {
            consecutiveFailures: event.consecutiveFailures,
            timestamp: event.timestamp.toISOString(),
          });
        }
      }),
    });
    this.baseUrl = config.baseUrl ?? OZON_BASE_URL;
    this.timeout = config.timeout ?? 30000;
    this.storeId = config.storeId;
  }

  // ============================================================
  // Public API Methods
  // ============================================================

  /** Health check — simple ping to verify connectivity */
  async ping(): Promise<boolean> {
    try {
      await this.doRequest("GET", "/v1/warehouse/list", {});
      return true;
    } catch {
      return false;
    }
  }

  /** Create a product draft (single) */
  async createDraft(product: OzonDraftInput): Promise<OzonDraftResult> {
    const response = await this.doRequest<{ result: { product_id: number; offer_id: string } }>(
      "POST",
      "/v3/product/import",
      {
        items: [{
          name: product.name,
          description: product.description,
          category_id: product.categoryId,
          price: product.price.toFixed(2),
          old_price: product.oldPrice
            ? product.oldPrice.toFixed(2)
            : (Math.round(product.price * 1.3 * 100) / 100).toFixed(2),
          vat: product.vat,
          images: product.specImageUrls,
          attributes: product.attributes,
          depth: product.dimensions.length,
          width: product.dimensions.width,
          height: product.dimensions.height,
          weight: product.dimensions.weight,
          barcode: product.barcode ?? undefined,
        }],
      }
    );

    return {
      productId: response.result.product_id,
      offerId: response.result.offer_id,
      status: "draft",
    };
  }

  /** Batch create drafts — auto-splits into chunks of 20 with 2s intervals */
  async batchCreateDrafts(products: OzonDraftInput[]): Promise<OzonDraftResult[]> {
    const CHUNK_SIZE = 20;
    const CHUNK_INTERVAL_MS = 2000;
    const results: OzonDraftResult[] = [];

    for (let i = 0; i < products.length; i += CHUNK_SIZE) {
      const chunk = products.slice(i, i + CHUNK_SIZE);

      const response = await this.doRequest<{
        result: Array<{ product_id: number; offer_id: string }>;
      }>(
        "POST",
        "/v3/product/import",
        {
          items: chunk.map((p) => ({
            name: p.name,
            description: p.description,
            category_id: p.categoryId,
            price: p.price.toFixed(2),
            old_price: p.oldPrice
              ? p.oldPrice.toFixed(2)
              : (Math.round(p.price * 1.3 * 100) / 100).toFixed(2),
            vat: p.vat,
            images: p.images,
            attributes: p.attributes,
            depth: p.dimensions.length,
            width: p.dimensions.width,
            height: p.dimensions.height,
            weight: p.dimensions.weight,
            barcode: p.barcode ?? undefined,
          })),
        }
      );

      results.push(
        ...response.result.map((r) => ({
          productId: r.product_id,
          offerId: r.offer_id,
          status: "draft" as const,
        }))
      );

      // Inter-chunk delay
      if (i + CHUNK_SIZE < products.length) {
        await new Promise((r) => setTimeout(r, CHUNK_INTERVAL_MS));
      }
    }

    return results;
  }

  /** Get product info to verify creation */
  async getProductInfo(productId: number): Promise<OzonProductInfo> {
    const response = await this.doRequest<{ result: OzonProductInfoApi }>(
      "POST",
      "/v3/product/info",
      { product_id: productId }
    );

    const r = response.result;
    return {
      id: r.id,
      offerId: r.offer_id,
      name: r.name,
      status: r.status,
      images: r.images ?? [],
      categoryId: r.category_id,
      price: r.price,
      commissionInfo: r.commissions ? { percent: r.commissions.sales_percent_fbo ?? 0 } : undefined,
    };
  }

  /** Get full category tree — uses Ozon description-category API */
  async getCategoryTree(categoryId?: number): Promise<OzonCategoryNode[]> {
    const body: Record<string, unknown> = categoryId
      ? { category_id: categoryId, language: "RU" }
      : { language: "RU" };

    const response = await this.doRequest<{ result: OzonCategoryApi[] }>(
      "POST",
      "/v1/description-category/tree",
      body
    );

    return response.result.map((n) => this.mapCategoryNode(n));
  }

  /** Get required attributes for a category */
  async getCategoryAttributes(categoryId: number): Promise<OzonAttribute[]> {
    const response = await this.doRequest<{ result: OzonAttributeApi[] }>(
      "POST",
      "/v1/description-category/attribute",
      {
        attribute_type: "ALL",
        category_id: categoryId,
        language: "RU",
      }
    );

    return response.result.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description ?? "",
      type: a.type as OzonAttribute["type"],
      isRequired: a.is_required ?? false,
      isCollection: a.is_collection ?? false,
      dictionary: a.dictionary?.map((d) => ({ id: d.id, value: d.value })),
    }));
  }

  // ---- Image Upload (two channels per Ozon spec) ----

  /**
   * Import product image from external URL.
   * Primary method for 1688→Ozon listing pipeline.
   * Endpoint: POST /v1/product/pictures/import
   */
  async importImageByUrl(imageUrl: string): Promise<OzonImageUploadResult> {
    const response = await this.doRequest<{ result: OzonUploadApi }>(
      "POST",
      "/v1/product/pictures/import",
      {
        url: imageUrl,
        primary: true,
      }
    );

    return {
      id: String(response.result.id),
      fileName: response.result.file_name ?? "product.jpg",
      url: response.result.url ?? "",
    };
  }

  /**
   * Upload local image file (base64 or binary).
   * Fallback when 1688 image is hotlink-protected.
   * Domain: upload.ozon.ru (NOT api-seller.ozon.ru).
   * Endpoint: POST /v1/upload
   */
  async uploadLocalImageFile(
    fileName: string,
    contentBase64: string
  ): Promise<OzonImageUploadResult> {
    if (typeof FormData === "undefined" || typeof Blob === "undefined") {
      throw new Error(
        "FormData/Blob not available. Upgrade to Node 22+ or install polyfill."
      );
    }

    const headers = this.auth.getHeaders(this.storeId);
    const formData = new FormData();
    const blob = new Blob([Buffer.from(contentBase64, "base64")]);
    formData.append("file", blob, fileName);

    const resp = await this.circuitBreaker.call(async () => {
      await this.rateLimiter.consume(1);

      return this.retry.execute(async () => {
        const res = await fetch("https://upload.ozon.ru/v1/upload", {
          method: "POST",
          headers: {
            "Client-Id": headers["Client-Id"],
            "Api-Key": headers["Api-Key"],
          },
          body: formData,
          signal: AbortSignal.timeout(this.timeout),
        });

        await this.handleResponseError(res);
        const data = await res.json();
        return data.result as OzonUploadApi;
      });
    });

    return {
      id: String(resp.id),
      fileName: resp.file_name ?? fileName,
      url: resp.url ?? "",
    };
  }

  /** @deprecated Use importImageByUrl instead. Kept for backward compat. */
  async uploadImageFromUrl(imageUrl: string): Promise<OzonImageUploadResult> {
    return this.importImageByUrl(imageUrl);
  }

  // ============================================================
  // Core Request Method
  // ============================================================

  private async doRequest<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    clientId?: string
  ): Promise<T> {
    return this.circuitBreaker.call(async () => {
      await this.rateLimiter.consume(1);

      return this.retry.execute(async () => {
        const headers = this.auth.getHeaders(clientId ?? this.storeId);

        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            "Client-Id": headers["Client-Id"],
            "Api-Key": headers["Api-Key"],
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeout),
        });

        await this.handleResponseError(response);
        return (await response.json()) as T;
      });
    });
  }

  /**
   * Maps HTTP responses to typed errors.
   * Only throws on non-success — 2xx returns void.
   */
  private async handleResponseError(response: Response): Promise<void> {
    if (response.ok) return;

    let ozonCode: string | undefined;
    let message = `Ozon API error: ${response.status} ${response.statusText}`;

    try {
      const body = await response.json();
      // Prefer body.error (more detailed), fall back to body.code
      if (body.error) {
        ozonCode = body.error.code;
        message = body.error.message ?? message;
      } else if (body.code) {
        ozonCode = body.code;
        message = body.message ?? message;
      }
    } catch {
      // No JSON body — use default message
    }

    switch (response.status) {
      case 429: {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
        throw new RateLimitError(message, retryAfterMs);
      }
      case 500:
      case 502:
      case 503:
      case 504:
        throw new ServerError(message, response.status);
      case 400:
        throw new ValidationError(message, ozonCode);
      case 401:
      case 403:
        throw new AuthError(message, response.status as 401 | 403);
      default:
        throw new FatalError(message, response.status, ozonCode);
    }
  }

  // ---- helpers ----

  private mapCategoryNode(node: OzonCategoryApi): OzonCategoryNode {
    return {
      categoryId: node.category_id,
      title: node.title,
      children: (node.children ?? []).map((c) => this.mapCategoryNode(c)),
    };
  }
}
