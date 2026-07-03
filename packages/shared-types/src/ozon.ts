// ============================================================
// Ozon API types
// ============================================================

export interface OzonCredentials {
  clientId: string;
  apiKey: string;
  storeId?: string;
}

export interface OzonDraftInput {
  name: string;
  description: string;
  categoryId: number;
  typeId?: number;
  price: number | string;
  oldPrice?: number;
  vat: string; // "0" | "0.1" | "0.2"
  images: string[]; // 1688 image URLs — Ozon downloads directly
  attributes: Array<{
    id: number;
    values: Array<{ value: string | number }>;
  }>;
  dimensions: {
    length: number; // mm
    width: number;
    height: number;
    weight: number; // grams
  };
  barcode?: string;
}

export interface OzonDraftResult {
  productId: number;
  offerId: string;
  status: string;
}

export interface OzonImageUploadResult {
  id: string;
  fileName: string;
  url: string;
}

export interface OzonCategoryNode {
  categoryId: number;
  title: string;
  typeId?: number; // leaf nodes have type_id for product/import
  children: OzonCategoryNode[];
}

export interface OzonAttribute {
  id: number;
  name: string;
  description: string;
  type: "string" | "number" | "list";
  isRequired: boolean;
  isCollection: boolean;
  dictionary?: Array<{ id: number; value: string }>;
}

export interface OzonProductInfo {
  id: number;
  offerId: string;
  name: string;
  status: string;
  images: string[];
  categoryId: number;
  price: string;
  commissionInfo?: { percent: number };
}
