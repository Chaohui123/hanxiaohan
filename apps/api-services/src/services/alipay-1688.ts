// ============================================================
// 1688 Open Platform — 免密代扣支付 SDK
// API docs: https://open.1688.com/
// Signs requests with HMAC-SHA256, handles JSON responses.
// ============================================================

import { logger } from "@onzo/logger";
import { createHmac, randomUUID } from "node:crypto";

// ---- Types ----

export interface AlipayConfig {
  appKey: string;
  appSecret: string;
  gateway: string;
}

export interface SigningStatusResult {
  signed: boolean;
  signDate?: string;
  channel: string; // alipay_deduct | chengyishe | kuajingbao
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

// ---- Config ----

function getConfig(): AlipayConfig {
  const appKey = process.env.ALIBABA_APP_KEY || "";
  const appSecret = process.env.ALIBABA_APP_SECRET || "";
  const gateway = process.env.ALIBABA_GATEWAY || "https://gw.open.1688.com/openapi/";

  if (!appKey || !appSecret) {
    logger.warn("1688 Alipay: ALIBABA_APP_KEY or ALIBABA_APP_SECRET not set — using mock mode");
  }

  return { appKey, appSecret, gateway };
}

// ---- HMAC-SHA256 Signing ----

function sign(params: Record<string, string>, secret: string): string {
  const sorted = Object.keys(params).sort();
  const query = sorted.map((k) => `${k}=${params[k]}`).join("&");
  return createHmac("sha256", secret).update(query).digest("hex").toUpperCase();
}

function buildSignedUrl(path: string, params: Record<string, string>, config: AlipayConfig): string {
  const timestamp = String(Date.now());
  const nonce = randomUUID().replace(/-/g, "");
  const signedParams = {
    ...params,
    app_key: config.appKey,
    timestamp,
    format: "json",
    v: "1.0",
    sign_method: "HMAC-SHA256",
    nonce,
  };
  const signature = sign(signedParams, config.appSecret);
  const query = new URLSearchParams({ ...signedParams, sign: signature }).toString();
  return `${config.gateway}${path}?${query}`;
}

// ---- Mock Helpers (when credentials not configured) ----

function isMock(): boolean {
  const config = getConfig();
  return !config.appKey || !config.appSecret;
}

// ---- Public API ----

/** 1. 检测买家免密签约状态 */
export async function checkSigningStatus(buyerId: string): Promise<SigningStatusResult> {
  if (isMock()) {
    logger.info({ buyerId }, "1688 Alipay [MOCK]: checkSigningStatus → signed=true");
    return { signed: true, signDate: new Date().toISOString(), channel: "alipay_deduct" };
  }

  const config = getConfig();
  try {
    const url = buildSignedUrl("param2/1/com.alibaba.trade/alibaba.trade.pay.protocol.get", { buyerId }, config);
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const data = await resp.json() as Record<string, unknown>;

    if (!resp.ok || (data.error_code && data.error_code !== "0")) {
      logger.warn({ buyerId, err: data.error_message }, "1688 Alipay: sign check failed");
      return { signed: false, channel: "alipay_deduct" };
    }

    return {
      signed: (data.signed as boolean) || (data.result as Record<string, unknown>)?.signed as boolean || false,
      signDate: (data.sign_date as string) || undefined,
      channel: "alipay_deduct",
    };
  } catch (err) {
    logger.error({ buyerId, err: (err as Error).message }, "1688 Alipay: sign check error");
    return { signed: false, channel: "alipay_deduct" };
  }
}

/** 2. 发起自动支付（免密代扣）*/
export async function autoDebit(params: AutoDebitParams): Promise<AutoDebitResult> {
  const paySerial = `PAY-${Date.now()}-${randomUUID().slice(0, 8)}`;

  if (isMock()) {
    logger.info({ ...params, paySerial }, "1688 Alipay [MOCK]: autoDebit → success");
    return { success: true, paySerial, tradeNo: `TRADE-${Date.now()}` };
  }

  const config = getConfig();
  try {
    const url = buildSignedUrl("param2/1/com.alibaba.trade/alibaba.trade.pay.protocol.pay", {
      buyerId: params.buyerId,
      orderId: params.orderId,
      totalAmount: String(Math.round(params.amountCny * 100)),
      subject: params.subject,
      notifyUrl: params.notifyUrl || "",
    }, config);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const data = await resp.json() as Record<string, unknown>;

    if (!resp.ok || (data.error_code && data.error_code !== "0")) {
      const errCode = (data.error_code as string) || "UNKNOWN";
      const errMsg = (data.error_message as string) || "Payment failed";
      logger.error({ params, errCode, errMsg }, "1688 Alipay: autoDebit failed");

      return {
        success: false,
        paySerial,
        errorCode: errCode,
        errorMsg: errMsg,
      };
    }

    return {
      success: true,
      paySerial,
      tradeNo: (data.trade_no as string) || (data.result as Record<string, unknown>)?.trade_no as string,
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ params, err: msg }, "1688 Alipay: autoDebit error");
    return { success: false, paySerial, errorCode: "NETWORK_ERROR", errorMsg: msg };
  }
}

/** 3. 查询支付结果 */
export async function queryPaymentResult(paySerial: string): Promise<PaymentQueryResult> {
  if (isMock()) {
    return { status: "paid", amount: 0, payTime: new Date().toISOString() };
  }

  const config = getConfig();
  try {
    const url = buildSignedUrl("param2/1/com.alibaba.trade/alibaba.trade.pay.result.get", { paySerial }, config);
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data = await resp.json() as Record<string, unknown>;

    if (!resp.ok) {
      return { status: "pending", amount: 0 };
    }

    return {
      status: (data.status as PaymentQueryResult["status"]) || "pending",
      amount: (Number(data.total_amount) || 0) / 100,
      payTime: (data.pay_time as string) || undefined,
    };
  } catch (err) {
    logger.error({ paySerial, err: (err as Error).message }, "1688 Alipay: query failed");
    return { status: "pending", amount: 0 };
  }
}