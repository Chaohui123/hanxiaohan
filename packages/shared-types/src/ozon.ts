// ============================================================
// Ozon API types
// ============================================================

export interface OzonCredentials {
  clientId: string;
  apiKey: string;
  storeId?: string;
}

export interface OzonDraftAttribute {
  id: number;
  values: Array<{ value: string | number }>;
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
  attributes?: OzonDraftAttribute[];
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
  taskId?: number;
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

// ---- Finance / Reconciliation ----

export interface OzonFinanceReportListResponse {
  result: {
    rows?: Array<{ report_id: string }>;
  };
}

export interface OzonFinanceReportRow {
  posting_number: string;
  order_id: string;
  operation_type: string;
  amount: number;
  commission: number;
  payout: number;
  services_amount: number;
}

export interface OzonFinanceReportDetailResponse {
  result: {
    report_id: string;
    begin_date: string;
    end_date: string;
    generated_at: string;
    rows?: OzonFinanceReportRow[];
  };
}
