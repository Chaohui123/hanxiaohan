// ============================================================
// Ozon Order Client — Fetch, sync, and manage FBO/FBS orders
// ============================================================

import type { OzonPosting, OzonPostingFilter, OzonPostingPage, OzonOrderStatus, LocalOrder } from "@onzo/shared-types";
import { OzonClient } from "@onzo/ozon-api-wrapper";

/** Raw Ozon API posting shape */
interface OzonPostingApi {
  posting_number: string;
  order_id: number;
  order_number: string;
  status: string;
  created_at?: string; // v4 列表已无此字段（2026-10-22 实测 v4 posting 无 created_at），仅 v3/详情接口有
  in_process_at: string;
  shipment_date?: string;
  products: Array<{
    sku: number; name: string; quantity: number;
    price: string; offer_id: string;
    currency_code?: string; // 订单货币（跨境店铺="CNY"），2026-09-19 补
  }>;
  financial_data?: {
    products: Array<{ price: string; commission_amount: string; payout: string }>;
  };
  delivery_method?: { name: string };
  tracking_number?: string;
  buyer?: {
    name: string; phone: string; email: string;
  };
  analytics_data?: { region?: string };
}

export class OzonOrderClient {
  private client: OzonClient;

  constructor(client: OzonClient) {
    this.client = client;
  }

  /** Fetch FBS postings with optional filter. （2026-08 官方废弃 v3→v4，cursor 分页） */
  async listPostings(filter?: OzonPostingFilter): Promise<OzonPostingPage> {
    const since = filter?.since || new Date(Date.now() - 7 * 86400000).toISOString();
    const until = filter?.until || new Date().toISOString();

    const response = await this.client.request<{ result?: { postings: OzonPostingApi[]; has_next: boolean; cursor: string }; postings?: OzonPostingApi[]; has_next?: boolean; cursor?: string }>(
      "POST",
      "/v4/posting/fbs/list",
      {
        dir: "asc",
        filter: {
          since,
          to: until,
          status: filter?.status || "",
          // Only include order_number when set — empty string is not accepted
          ...(filter?.orderNumber ? { order_number: filter.orderNumber } : {}),
        },
        limit: filter?.limit ?? 100,
        // v4 为 cursor 分页：空串=第一页（offset 已废弃勿传）
        cursor: filter?.cursor ?? "",
        // 必须显式请求 financial_data，否则 payout/commission 恒为 0（2026-09-19 货币口径修复）
        with: { financial_data: true },
      }
    );

    // 新端点响应不包 result 层（顶层即数据），老结构兼容兜底
    const res = response.result ?? response;
    return {
      postings: (res.postings ?? []).map(this.mapPosting),
      cursor: res.cursor ?? "",
      hasNext: Boolean(res.has_next && (res.postings ?? []).length > 0),
    };
  }

  /** Fetch FBO postings.（2026-08 官方废弃 v2→v3，cursor 分页） */
  async listFboPostings(filter?: OzonPostingFilter): Promise<OzonPostingPage> {
    const since = filter?.since || new Date(Date.now() - 7 * 86400000).toISOString();
    const until = filter?.until || new Date().toISOString();

    const response = await this.client.request<{ result?: { postings: OzonPostingApi[]; has_next: boolean; cursor: string }; postings?: OzonPostingApi[]; has_next?: boolean; cursor?: string }>(
      "POST",
      "/v3/posting/fbo/list",
      {
        dir: "asc",
        filter: {
          since,
          to: until,
          status: filter?.status || "",
        },
        limit: filter?.limit ?? 100,
        cursor: filter?.cursor ?? "",
        with: { financial_data: true },
      }
    );

    // 新端点响应不包 result 层（顶层即数据），老结构兼容兜底
    const res = response.result ?? response;
    return {
      postings: (res.postings ?? []).map(this.mapPosting),
      cursor: res.cursor ?? "",
      hasNext: Boolean(res.has_next && (res.postings ?? []).length > 0),
    };
  }

  /** Get a single posting by number */
  async getPosting(postingNumber: string): Promise<OzonPosting> {
    const response = await this.client.request<{ result: OzonPostingApi }>(
      "POST",
      "/v3/posting/fbs/get",
      { posting_number: postingNumber, with: { financial_data: true } }
    );

    return this.mapPosting(response.result);
  }

  /** Ship an FBS order with tracking number. */
  async shipOrder(
    postingNumber: string,
    trackingNumber: string,
    products: Array<{ sku: number; quantity: number }>
  ): Promise<void> {
    await this.client.request(
      "POST",
      "/v3/posting/fbs/ship",
      {
        posting_number: postingNumber,
        tracking_number: trackingNumber,
        products: products.map((p) => ({
          product_id: p.sku,
          quantity: p.quantity,
        })),
      }
    );
  }

  /** Mark order as delivered (last mile). */
  async markDelivered(postingNumber: string): Promise<void> {
    await this.client.request(
      "POST",
      "/v3/posting/fbs/delivered",
      { posting_number: postingNumber }
    );
  }

  /** Cancel an order. */
  async cancelOrder(postingNumber: string, reason: string): Promise<void> {
    await this.client.request(
      "POST",
      "/v3/posting/fbs/cancel",
      {
        posting_number: postingNumber,
        cancel_reason_id: 352, // generic seller cancellation
        cancel_reason_message: reason,
      }
    );
  }

  // ---- private ----

  private mapPosting(api: OzonPostingApi): OzonPosting {
    const products: OzonPosting["products"] = (api.products ?? []).map((p) => ({
      sku: p.sku,
      name: p.name,
      quantity: p.quantity,
      price: parseFloat(p.price) || 0,
      offerId: p.offer_id,
    }));

    const financials = api.financial_data?.products?.[0];
    const totalPrice = products.reduce((sum, p) => sum + p.price * p.quantity, 0);

    return {
      postingNumber: api.posting_number,
      orderId: api.order_id,
      orderNumber: api.order_number,
      status: api.status as OzonOrderStatus,
      createdAt: api.created_at ?? api.in_process_at ?? "", // v4 无 created_at，回退 in_process_at（≈下单时间，2026-10-22 实证 ozon_orders.created_at_ozon 两行为 NULL）
      inProcessAt: api.in_process_at,
      shipmentDate: api.shipment_date,
      buyerName: maskString(api.buyer?.name || "", 2, 1),
      buyerPhone: maskPhone(api.buyer?.phone || ""),
      buyerEmail: maskEmail(api.buyer?.email || ""),
      products,
      price: totalPrice,
      currencyCode: api.products?.[0]?.currency_code,
      commission: parseFloat(financials?.commission_amount || "0"),
      payout: parseFloat(financials?.payout || "0"),
      deliveryMethod: api.delivery_method?.name || "",
      trackingNumber: api.tracking_number,
    };
  }
}

// ---- Data masking utilities ----

function maskString(value: string, keepStart: number, keepEnd: number): string {
  if (!value || value.length <= keepStart + keepEnd) return value;
  return value.substring(0, keepStart) + "***" + value.substring(value.length - keepEnd);
}

function maskPhone(phone: string): string {
  if (!phone) return "";
  return phone.substring(0, 2) + "****" + phone.substring(phone.length - 4);
}

function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return email;
  const [name, domain] = email.split("@");
  return name.substring(0, 2) + "***@" + domain;
}
