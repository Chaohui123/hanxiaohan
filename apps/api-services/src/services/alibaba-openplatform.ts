// ============================================================
// 1688 Open Platform SDK — real API integration
// AppKey: 1390512, Auth: OAuth access_token
// API docs: https://open.1688.com/
// ============================================================

import { logger } from "@onzo/logger";
import { createHmac, randomUUID } from "node:crypto";

// ---- Types ----

export interface AlibabaConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  gateway: string;
}

export interface SigningStatusResult {
  signed: boolean;
  signDate?: string;
  channel: string;
}

export interface AutoDebitParams {
  buyerId: string;
  orderId: string;
  amountCny: number;
  subject: string;
  notifyUrl?: string;
}

export interface AutoDebitResult {
  success: boolean;
  paySerial: string;
  tradeNo?: string;
  errorCode?: string;
  errorMsg?: string;
}

export interface PaymentQueryResult {
  status: "paid" | "pending" | "failed";
  amount: number;
  payTime?: string;
}

export interface CreateOrderParams {
  buyerId: string;
  offerId: string;
  quantity: number;
  unitPriceCny: number;
  subject: string;
  storeId?: string;
}

export interface CreateOrderResult {
  success: boolean;
  orderId?: string;
  totalAmountCny?: number;
  errorCode?: string;
  errorMsg?: string;
}

export interface QueryOrderResult {
  orderId: string;
  status: "pending" | "paid" | "shipped" | "delivered" | "cancelled" | "refunded";
  totalAmountCny: number;
  logisticsStatus?: string;
  trackingNumber?: string;
  items: Array<{ offerId: string; quantity: number; unitPriceCny: number }>;
}

export interface LogisticsTraceResult {
  trackingNumber: string;
  status: string;
  details: Array<{ time: string; status: string; location?: string }>;
}

// ---- Config ----

function getConfig(): AlibabaConfig {
  return {
    appKey: process.env.ALIBABA_APP_KEY || "1390512",
    appSecret: process.env.ALIBABA_APP_SECRET || "",
    accessToken: process.env.ALIBABA_ACCESS_TOKEN || "",
    gateway: process.env.ALIBABA_GATEWAY || "https://gw.open.1688.com/openapi/",
  };
}

function isMock(): boolean {
  const config = getConfig();
  return !config.appSecret || !config.accessToken;
}

// ---- HMAC-SHA256 Signing (1688 Open Platform spec) ----

function sign(params: Record<string, string>, secret: string): string {
  const sorted = Object.keys(params).sort();
  const query = sorted.map((k) => `${k}=${params[k]}`).join("");
  return createHmac("sha256", secret).update(query).digest("hex").toUpperCase();
}

/** Build signed 1688 Open Platform URL.
 *  1688 URL format: {gateway}param2/1/{apiNamespace}/{apiName}/{appKey}
 *  Signature computed on all query params sorted, concatenated, + secret. */
function buildRequestUrl(apiPath: string, params: Record<string, string>): string {
  const config = getConfig();
  const timestamp = String(Date.now());
  const nonce = randomUUID().replace(/-/g, "").slice(0, 16);

  const signedParams: Record<string, string> = {
    ...params,
    access_token: config.accessToken,
    app_key: config.appKey,
    timestamp,
    format: "json",
    v: "1.0",
    sign_method: "HMAC-SHA256",
    nonce,
  };

  // Remove empty values
  for (const k of Object.keys(signedParams)) {
    if (!signedParams[k]) delete signedParams[k];
  }

  const signature = sign(signedParams, config.appSecret);
  const query = new URLSearchParams({ ...signedParams, sign: signature }).toString();
  return `${config.gateway}${apiPath}/${config.appKey}?${query}`;
}

// ---- HTTP Client with Retry ----

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeout?: number;
}

async function apiRequest<T>(apiPath: string, params: Record<string, string>, opts: RequestOptions = {}): Promise<T> {
  const config = getConfig();
  const url = buildRequestUrl(apiPath, params);
  const timeout = opts.timeout || 30_000;
  const maxRetries = 2;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      logger.debug({ apiPath, attempt, params: { ...params, access_token: "***" } }, "1688 API: request");

      const resp = await fetch(url, {
        method: opts.method || "GET",
        headers: opts.body ? { "Content-Type": "application/json" } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });

      const data = await resp.json() as Record<string, unknown>;

      // Log response
      logger.debug({ apiPath, status: resp.status, errorCode: data.error_code, hasResult: !!data.result },
        "1688 API: response");

      if (!resp.ok || (data.error_code && data.error_code !== "0" && data.error_code !== "200")) {
        const errCode = String(data.error_code || resp.status);
        const errMsg = String(data.error_message || data.msg || data.error || "Unknown error");

        // Categorize errors
        if (errCode.includes("403") || errCode.includes("IP") || errCode.includes("whitelist")) {
          throw new AlibabaApiError(errCode, `IP白名单异常: ${errMsg}`, "IP_WHITELIST");
        }
        if (errCode.includes("401") || errCode.includes("token") || errCode.includes("expired")) {
          throw new AlibabaApiError(errCode, `Token/权限过期: ${errMsg}`, "PERMISSION_EXPIRED");
        }
        if (errCode.includes("balance") || errCode.includes("INSUFFICIENT") || errCode.includes("not enough")) {
          throw new AlibabaApiError(errCode, `余额不足: ${errMsg}`, "INSUFFICIENT_BALANCE");
        }

        throw new AlibabaApiError(errCode, errMsg, "API_ERROR");
      }

      // 1688 wraps results in different keys
      const result = data.result ?? data.data ?? data;
      return result as T;
    } catch (err) {
      if (err instanceof AlibabaApiError) {
        if (err.category === "IP_WHITELIST" || err.category === "PERMISSION_EXPIRED") {
          throw err; // don't retry fatal errors
        }
      }
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 4000);
        logger.warn({ apiPath, attempt, err: lastError.message }, "1688 API: retrying");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError!;
}

// ---- Error Class ----

export class AlibabaApiError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
    public readonly category: "IP_WHITELIST" | "PERMISSION_EXPIRED" | "INSUFFICIENT_BALANCE" | "API_ERROR" | "NETWORK_ERROR"
  ) {
    super(message);
    this.name = "AlibabaApiError";
  }
}

// ---- Public API ----

/** 1. 检测免密签约状态 */
export async function checkSigningStatus(buyerId: string): Promise<SigningStatusResult> {
  if (isMock()) {
    logger.info({ buyerId }, "1688 [MOCK]: checkSigningStatus → signed=true");
    return { signed: true, signDate: new Date().toISOString(), channel: "alipay_deduct" };
  }

  try {
    const data = await apiRequest<Record<string, unknown>>(
      "param2/1/com.alibaba.trade/alibaba.trade.pay.protocol.get",
      { buyerId }
    );
    return {
      signed: (data.signed as boolean) || (data.result as Record<string, unknown>)?.signed as boolean || false,
      signDate: (data.sign_date as string) || undefined,
      channel: "alipay_deduct",
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ buyerId, err: msg }, "1688: sign check failed");
    return { signed: false, channel: "alipay_deduct" };
  }
}

/** 2. 发起免密代扣支付 */
export async function autoDebit(params: AutoDebitParams): Promise<AutoDebitResult> {
  const paySerial = `PAY-${Date.now()}-${randomUUID().slice(0, 8)}`;

  if (isMock()) {
    logger.info({ ...params, paySerial }, "1688 [MOCK]: autoDebit → success");
    return { success: true, paySerial, tradeNo: `TRADE-${Date.now()}` };
  }

  try {
    const data = await apiRequest<Record<string, unknown>>(
      "param2/1/com.alibaba.trade/alibaba.trade.pay.protocol.pay",
      {},
      {
        method: "POST",
        body: {
          buyerId: params.buyerId,
          orderId: params.orderId,
          totalAmount: String(Math.round(params.amountCny * 100)),
          subject: params.subject,
          notifyUrl: params.notifyUrl || "",
        },
        timeout: 60_000,
      }
    );

    return {
      success: true,
      paySerial,
      tradeNo: (data.trade_no as string) || (data.pay_no as string) || undefined,
    };
  } catch (err) {
    if (err instanceof AlibabaApiError) {
      logger.error({ params, errorCode: err.errorCode, category: err.category }, "1688: autoDebit failed");
      return { success: false, paySerial, errorCode: err.errorCode, errorMsg: err.message };
    }
    const msg = (err as Error).message;
    logger.error({ params, err: msg }, "1688: autoDebit error");
    return { success: false, paySerial, errorCode: "NETWORK_ERROR", errorMsg: msg };
  }
}

/** 3. 查询支付结果 */
export async function queryPaymentResult(paySerial: string): Promise<PaymentQueryResult> {
  if (isMock()) {
    return { status: "paid", amount: 0, payTime: new Date().toISOString() };
  }

  try {
    const data = await apiRequest<Record<string, unknown>>(
      "param2/1/com.alibaba.trade/alibaba.trade.pay.result.get",
      { paySerial }
    );
    return {
      status: (data.status as PaymentQueryResult["status"]) || "pending",
      amount: (Number(data.total_amount) || 0) / 100,
      payTime: (data.pay_time as string) || undefined,
    };
  } catch (err) {
    logger.error({ paySerial, err: (err as Error).message }, "1688: query payment failed");
    return { status: "pending", amount: 0 };
  }
}

/** 4. 创建采购单 */
export async function createPurchaseOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  if (isMock()) {
    const mockOrderId = `ORDER-${Date.now()}-${randomUUID().slice(0, 6)}`;
    logger.info({ ...params, mockOrderId }, "1688 [MOCK]: createPurchaseOrder → success");
    return {
      success: true,
      orderId: mockOrderId,
      totalAmountCny: Math.round(params.quantity * params.unitPriceCny * 100) / 100,
    };
  }

  try {
    const data = await apiRequest<Record<string, unknown>>(
      "param2/1/com.alibaba.trade/alibaba.trade.create.order",
      {},
      {
        method: "POST",
        body: {
          buyerId: params.buyerId,
          productId: params.offerId,
          quantity: String(params.quantity),
          price: String(Math.round(params.unitPriceCny * 100)),
          subject: params.subject,
        },
        timeout: 30_000,
      }
    );

    const orderId = (data.order_id as string) || (data.orderId as string) || "";
    if (!orderId) {
      return { success: false, errorCode: "NO_ORDER_ID", errorMsg: "1688 returned no order ID" };
    }

    logger.info({ orderId, offerId: params.offerId, quantity: params.quantity }, "1688: Purchase order created");
    return {
      success: true,
      orderId,
      totalAmountCny: Math.round(params.quantity * params.unitPriceCny * 100) / 100,
    };
  } catch (err) {
    if (err instanceof AlibabaApiError) {
      return { success: false, errorCode: err.errorCode, errorMsg: err.message };
    }
    return { success: false, errorCode: "NETWORK_ERROR", errorMsg: (err as Error).message };
  }
}

/** 5. 查询订单详情 */
export async function queryOrder(orderId: string): Promise<QueryOrderResult | null> {
  if (isMock()) {
    return {
      orderId,
      status: "paid",
      totalAmountCny: 500,
      items: [{ offerId: "mock-offer", quantity: 1, unitPriceCny: 500 }],
    };
  }

  try {
    const data = await apiRequest<Record<string, unknown>>(
      "param2/1/com.alibaba.trade/alibaba.trade.get.order",
      { orderId }
    );

    return {
      orderId: (data.order_id as string) || orderId,
      status: (data.status as QueryOrderResult["status"]) || "pending",
      totalAmountCny: (Number(data.total_amount) || 0) / 100,
      logisticsStatus: data.logistics_status as string | undefined,
      trackingNumber: data.tracking_number as string | undefined,
      items: ((data.items || data.products || []) as Array<Record<string, unknown>>).map((i) => ({
        offerId: String(i.offer_id || i.offerId || ""),
        quantity: Number(i.quantity) || 1,
        unitPriceCny: (Number(i.price) || 0) / 100,
      })),
    };
  } catch (err) {
    logger.error({ orderId, err: (err as Error).message }, "1688: query order failed");
    return null;
  }
}

/** 6. 查询物流轨迹 */
export async function getLogisticsTrace(trackingNumber: string): Promise<LogisticsTraceResult | null> {
  if (isMock()) {
    return {
      trackingNumber,
      status: "in_transit",
      details: [
        { time: new Date(Date.now() - 3600000).toISOString(), status: "已揽收", location: "义乌转运中心" },
        { time: new Date().toISOString(), status: "运输中", location: "中俄边境" },
      ],
    };
  }

  try {
    const data = await apiRequest<Record<string, unknown>>(
      "param2/1/com.alibaba.logistics/alibaba.logistics.trace.get",
      { trackingNumber }
    );

    const traceList = (data.trace_list || data.traces || data.details || []) as Array<Record<string, unknown>>;

    return {
      trackingNumber: (data.tracking_number as string) || trackingNumber,
      status: (data.status as string) || (data.logistics_status as string) || "unknown",
      details: traceList.map((t) => ({
        time: (t.time as string) || (t.accept_time as string) || "",
        status: (t.status as string) || (t.remark as string) || "",
        location: (t.location as string) || (t.address as string) || undefined,
      })),
    };
  } catch (err) {
    logger.error({ trackingNumber, err: (err as Error).message }, "1688: logistics trace failed");
    return null;
  }
}

/** 7. 申请退款（部分/全额）*/
export async function createRefund(params: {
  orderId: string;
  amountCny: number;
  reason: string;
}): Promise<{ success: boolean; refundId?: string; errorMsg?: string }> {
  if (isMock()) {
    return { success: true, refundId: `RF-${Date.now()}-${randomUUID().slice(0, 6)}` };
  }
  try {
    const data = await apiRequest<Record<string, unknown>>(
      "param2/1/com.alibaba.trade/alibaba.trade.refund.apply",
      {},
      { method: "POST", body: { orderId: params.orderId, refundAmount: String(Math.round(params.amountCny * 100)), reason: params.reason } }
    );
    return { success: true, refundId: (data.refund_id as string) || (data.refundId as string) };
  } catch (err) {
    return { success: false, errorMsg: (err as Error).message };
  }
}

// Backward-compat re-exports from old alipay-1688.ts
export type { AlipayConfig as AlipayConfig_DEPRECATED } from "./alipay-1688.js";