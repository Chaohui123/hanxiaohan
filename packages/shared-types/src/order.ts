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
  // 注意货币口径（2026-09-19 实证）：跨境店铺 products[].price 是 CNY 定价，
  // price 汇总值同为订单货币（CNY），并非 RUB；RUB 口径需 ×汇率 或用 payout。
  price: number;               // 订单货币金额（跨境=CNY 定价口径），勿直接当 RUB
  currencyCode?: string;       // 订单货币，如 "CNY"/"RUB"（products[0].currency_code）
  commission: number;          // RUB, Ozon fee（financial_data，list 需 with.financial_data=true）
  payout: number;              // RUB, seller receives（financial_data，已扣佣金、未扣物流）

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
  orderNumber?: string;        // filter by order_number (fbs/list supports it)
  limit?: number;              // default 100
  offset?: number;
}

// ---- Ozon Order Sync v2 ----

export interface OzonOrderProduct {
  sku: number;
  name: string;
  quantity: number;
  price: number;               // 订单货币单价（跨境=CNY 定价口径，非 RUB）
  offerId: string;
  source1688Url?: string;      // matched from sku_1688_mapping / listing_records
  costCny?: number;            // 真实采购价 CNY（sku_1688_mapping.purchase_price_cny）
  weightKg?: number;           // 映射表重量（物流分档用）
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
