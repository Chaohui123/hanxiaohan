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
