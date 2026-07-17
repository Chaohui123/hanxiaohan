// ============================================================
// Ozon Order types — FBO/FBS order lifecycle
// ============================================================

export type OzonOrderStatus =
  | "awaiting_packaging"   // FBS: waiting to be packed
  | "awaiting_deliver"     // FBS: ready for shipping
  | "delivering"           // FBS: in transit
  | "delivered"            // FBS/FBO: delivered to buyer
  | "cancelled";           // cancelled

export interface OzonPosting {
  postingNumber: string;       // unique order number
  orderId: number;
  orderNumber: string;
  status: OzonOrderStatus;
  createdAt: string;           // ISO
  inProcessAt: string;
  shipmentDate?: string;

  // Buyer info (masked for privacy)
  buyerName: string;           // masked: "Ivan I."
  buyerPhone: string;          // masked: "+7900***1234"
  buyerEmail: string;          // masked: "iv***@mail.ru"

  // Product(s) in this posting
  products: OzonPostingProduct[];

  // Financials
  price: number;               // RUB, buyer paid
  commission: number;          // RUB, Ozon fee
  payout: number;              // RUB, seller receives

  // Logistics
  deliveryMethod: string;
  trackingNumber?: string;
  warehouseId?: number;

  // Address (for FBS shipping label)
  deliveryAddress?: {
    country: string;
    city: string;
    street: string;
    postcode: string;
  };
}

export interface OzonPostingProduct {
  sku: number;
  name: string;
  quantity: number;
  price: number;               // RUB per unit
  offerId: string;
}

export interface OzonPostingFilter {
  status?: OzonOrderStatus;
  since?: string;              // ISO datetime
  until?: string;              // ISO datetime
  limit?: number;              // default 100
  offset?: number;
}

// ---- Ozon Order Sync v2 ----

export interface OzonOrderProduct {
  sku: number;
  name: string;
  quantity: number;
  price: number;               // RUB per unit
  offerId: string;
  source1688Url?: string;      // matched from listing_records
  costCny?: number;            // from price_history
  profitMargin?: number;       // calculated per product
}

export interface OzonOrder {
  id: string;
  storeId: string;
  postingNumber: string;
  orderId: number;
  orderNumber?: string;
  status: string;
  createdAtOzon: string;
  shipmentDeadline?: string;
  buyerName: string;
  buyerPhone: string;
  products: OzonOrderProduct[];
  totalPriceRub: number;
  totalCostCny: number;
  totalProfitRub: number;
  marginPercent: number;
  has1688Source: boolean;
  profitOk: boolean;
  needsReview: boolean;
  trackingNumber?: string;
  syncedAt: string;
  updatedAt: string;
}

export interface SyncSummary {
  storesScanned: number;
  totalOrders: number;
  newOrders: number;
  flaggedOrders: number;
  skippedOrders: number;
  errors: string[];
}

/** Locally stored order record (decoupled from Ozon raw shape) */
export interface LocalOrder {
  id: string;
  postingNumber: string;
  orderId: number;
  status: OzonOrderStatus;
  createdAt: string;
  updatedAt: string;
  buyerNameMasked: string;
  buyerPhoneMasked: string;
  totalPriceRub: number;
  commissionRub: number;
  payoutRub: number;
  productCount: number;
  trackingNumber?: string;
  rawJson: string; // full Ozon response for audit
}
