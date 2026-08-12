// ============================================================
// Ozon Ads Service — Performance API 客户端（真实广告花费/订单）
// BASE: https://api-performance.ozon.ru
// 凭据从 env 读取：OZON_PERF_CLIENT_ID / OZON_PERF_CLIENT_SECRET
// env 未配置或 API 失败时返回 null（调用方可区分"无数据"与"0"）
// ============================================================

import { logger } from "@onzo/logger";

const BASE = "https://api-performance.ozon.ru";
const TOKEN_TTL_MS = 1500_000; // token 缓存 25 分钟
const REQUEST_TIMEOUT_MS = 10_000;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export interface AdDailyStats {
  spendRub: number;
  shows: number;
  clicks: number;
  adOrders: number;
  adRevenueRub: number;
}

function getCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.OZON_PERF_CLIENT_ID;
  const clientSecret = process.env.OZON_PERF_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const res = await fetch(`${BASE}/api/client/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
  const data = await res.json() as { access_token?: string };
  if (!data.access_token) throw new Error("token response missing access_token");
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
  return cachedToken;
}

/** daily/json 的数字字段可能是 "1 234,56" 格式的字符串 */
function parseNum(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 按区间聚合广告按天数据（moneySpent/ordersMoney 单位为卢布）。
 * env 未配置或 API 失败返回 null。
 */
export async function getAdDailyStats(fromDate: string, toDate: string): Promise<AdDailyStats | null> {
  const creds = getCredentials();
  if (!creds) {
    logger.warn("Ozon Performance API credentials not configured (OZON_PERF_CLIENT_ID/SECRET) — ad stats unavailable");
    return null;
  }
  try {
    const token = await getToken(creds.clientId, creds.clientSecret);
    const res = await fetch(`${BASE}/api/client/statistics/daily/json?dateFrom=${fromDate}&dateTo=${toDate}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`daily stats failed: HTTP ${res.status}`);
    const data = await res.json() as { rows?: Array<Record<string, unknown>> };
    const stats: AdDailyStats = { spendRub: 0, shows: 0, clicks: 0, adOrders: 0, adRevenueRub: 0 };
    for (const row of data.rows || []) {
      stats.shows += parseNum(row.views);
      stats.clicks += parseNum(row.clicks);
      stats.spendRub += parseNum(row.moneySpent);
      stats.adOrders += parseNum(row.orders);
      stats.adRevenueRub += parseNum(row.ordersMoney);
    }
    return stats;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Ozon Performance API request failed — ad stats unavailable");
    return null;
  }
}

/** 清空 token 缓存（测试用） */
export function resetAdTokenCache(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
}
