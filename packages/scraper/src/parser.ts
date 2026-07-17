// ============================================================
// HTML Parser — Extract structured product data from 1688 pages
// ============================================================

import type { ScrapedProduct } from "@onzo/shared-types";

/** Raw data extracted from a 1688 page before parsing into ScrapedProduct. */
export interface ExtractedPageData {
  title: string;
  html: string;
  url: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  ldJson: string | null;
  initialState: SkuState | null;
  images: string[];
  metaKeywords: string;
  supplier?: {
    name: string;
    pickupRate: number;
    responseRate: number;
    qualityScore: number;
  };
}

/** Inferred shape of 1688's window.__INITIAL_STATE__ or embedded JSON. */
interface SkuState {
  sku?: {
    skuPriceRange?: { lowestPrice?: string; highestPrice?: string };
    skuImageList?: Array<{ url?: string }>;
    skuProps?: Array<{ prop?: string; name?: string; value?: string }>;
    soldCount?: string;
  };
  globalData?: {
    categoryPath?: string[];
  };
}

/**
 * Extract product data from a 1688 detail page.
 * Uses DOM selectors and embedded JSON data.
 */
export function parseProductPage(
  pageContent: ExtractedPageData,
  sourceUrl: string
): ScrapedProduct {
  // 1. Title — prefer h1, fall back to og:title
  const title = pageContent.title || pageContent.ogTitle || "";

  // 2. Price — try initialState JSON, then meta
  let priceMin = 0;
  let priceMax = 0;
  if (pageContent.initialState?.sku?.skuPriceRange) {
    const range = pageContent.initialState.sku.skuPriceRange;
    priceMin = parseFloat(range.lowestPrice ?? "0");
    priceMax = parseFloat(range.highestPrice ?? "0");
  }

  // 3. Spec images — prefer initialState, fall back to extracted images
  let specImages: string[] = [];
  if (pageContent.initialState?.sku?.skuImageList) {
    specImages = pageContent.initialState.sku.skuImageList
      .filter((img) => img.url)
      .map((img) => (img.url!.startsWith("//") ? `https:${img.url}` : img.url!));
  } else {
    specImages = pageContent.images.filter(
      (url) => !url.includes("icon") && !url.includes("avatar")
    );
  }

  // 4. Detail images — from description area
  const detailImages: string[] = []; // extracted separately by scraper.ts

  // 5. Specifications — parse from initialState or LD JSON
  let specifications: Array<{ name: string; value: string }> = [];
  if (pageContent.initialState?.sku?.skuProps) {
    specifications = pageContent.initialState.sku.skuProps.map((prop) => ({
      name: prop.prop ?? prop.name ?? "",
      value: prop.value ?? "",
    }));
  }

  // 6. Description text
  const descriptionText = pageContent.ogDescription || "";

  // 7. Category path
  let categoryPath: string[] = [];
  if (pageContent.initialState?.globalData?.categoryPath) {
    categoryPath = pageContent.initialState.globalData.categoryPath;
  } else if (pageContent.metaKeywords) {
    categoryPath = pageContent.metaKeywords.split(",").map((k) => k.trim()).slice(0, 3);
  }

  // 8. Sales info
  const salesInfo: ScrapedProduct["salesInfo"] = {};
  if (pageContent.initialState?.sku?.soldCount) {
    salesInfo.totalSold = parseInt(pageContent.initialState.sku.soldCount, 10) || undefined;
  }

  return {
    sourceUrl,
    scrapeTimestamp: new Date().toISOString(),
    title: title.trim(),
    price: {
      currentMin: priceMin,
      currentMax: priceMax,
      currency: "CNY",
    },
    specImages: specImages.filter(Boolean),
    detailImages: detailImages.filter(Boolean),
    specifications,
    descriptionText: descriptionText.trim(),
    categoryPath,
    salesInfo,
    supplier: pageContent.supplier ? {
      name: pageContent.supplier.name || "",
      pickupRate: pageContent.supplier.pickupRate || 0,
      responseRate: pageContent.supplier.responseRate || 0,
      qualityScore: pageContent.supplier.qualityScore || 0,
    } : undefined,
  };
}

/**
 * Sanitize a scraped URL — convert protocol-relative URLs to absolute.
 */
export function sanitizeUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://detail.1688.com${url}`;
  return url;
}
