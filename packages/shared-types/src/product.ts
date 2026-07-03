// ============================================================
// Product types — ScrapedProduct (from 1688), ProcessedProduct (enriched)
// ============================================================

export interface ScrapedProduct {
  sourceUrl: string;
  scrapeTimestamp: string; // ISO 8601
  title: string;
  price: {
    currentMin: number;
    currentMax: number;
    currency: "CNY";
  };
  specImages: string[];
  detailImages: string[];
  specifications: Array<{ name: string; value: string }>;
  descriptionText: string;
  categoryPath: string[];
  salesInfo?: {
    totalSold?: number;
    reviewCount?: number;
    rating?: number;
  };
}

export interface ProcessedProduct {
  // From scraper
  sourceUrl: string;
  titleCn: string;
  priceCny: { min: number; max: number };
  specImageUrls: string[];
  detailImageUrls: string[];
  specificationsCn: Array<{ name: string; value: string }>;

  // From OCR
  ocrTexts: string[];

  // From GLM translation
  titleRu: string;
  descriptionRu: string;
  specificationsRu: Array<{ name: string; value: string }>;

  // From GLM category matching
  categoryId: number;
  categoryName: string;
  categoryPath: string[];
  attributes: Array<{
    attributeId: number;
    name: string;
    value: string | number | string[];
  }>;

  // Computed
  priceRub: number;
  dimensionsCm: { length: number; width: number; height: number };
  weightKg: number;

  // After image upload
  imageIds: string[];
}

export interface ListingTask {
  id: string;
  storeId: string;
  sourceUrl: string;
  status: "pending" | "scraping" | "translating" | "uploading" | "creating_draft" | "done" | "failed";
  error?: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  result?: {
    draftId?: string;
    ozonProductId?: string;
    ozonUrl?: string;
  };
}
