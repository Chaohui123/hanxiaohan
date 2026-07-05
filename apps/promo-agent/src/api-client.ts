export interface ApiConfig {
  apiBase: string;
  apiKey: string;
  storeId?: string;
}

async function api<T>(config: ApiConfig, method: string, path: string, body?: unknown): Promise<T> {
  const url = `${config.apiBase}${path}`;
  const headers: Record<string, string> = {
    "X-API-Key": config.apiKey,
    "Content-Type": "application/json",
  };
  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

// ---- 推广 API ----
export const promoApi = {
  inventory: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/inventory"),
  inventoryAlerts: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/inventory/alerts"),
  orders: (c: ApiConfig, days?: number) =>
    api<Record<string, unknown>>(c, "GET", `/api/orders?days=${days || 7}`),
  exchangeRate: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/stores/fx"),
  stores: (c: ApiConfig) => api<{ items: Array<{ storeId: string; storeName: string; active: number }> }>(c, "GET", "/api/stores"),
  dashboard: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/dashboard"),
  products: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/inventory?limit=100"),
  getProduct: (c: ApiConfig, offerId: string) =>
    api<Record<string, unknown>>(c, "GET", `/api/inventory/${offerId}`),
  updatePrice: (c: ApiConfig, offerId: string, price: number) =>
    api<Record<string, unknown>>(c, "PUT", `/api/inventory/${offerId}/price`, { price }),
  updateProduct: (c: ApiConfig, offerId: string, data: Record<string, unknown>) =>
    api<Record<string, unknown>>(c, "PUT", `/api/inventory/${offerId}`, data),
  getSalesRanking: (c: ApiConfig, days?: number) =>
    api<{ items: Array<{ offerId: string; name: string; orders: number; revenue: number; growth: number }> }>(
      c, "GET", `/api/promo/sales-ranking?days=${days || 7}`,
    ),
  getPromoHistory: (c: ApiConfig, days?: number) =>
    api<{ actions: Array<{ offerId: string; type: string; result: string; appliedAt: string }> }>(
      c, "GET", `/api/promo/history?days=${days || 7}`,
    ),
  submitDecision: (c: ApiConfig, plan: { id: string; actions: Array<{ offerId: string; type: string; suggestedPrice?: number }> }) =>
    api<Record<string, unknown>>(c, "POST", "/api/promo/decision", plan),
};

// ---- 竞品监控 API ----
export const competitorApi = {
  getWatchList: (c: ApiConfig) => api<{ items: Array<{ offerId: string; name: string }> }>(c, "GET", "/api/promo/watch-list"),
  addWatch: (c: ApiConfig, offerId: string) =>
    api<Record<string, unknown>>(c, "POST", "/api/promo/watch-list", { offerId }),
  removeWatch: (c: ApiConfig, offerId: string) =>
    api<Record<string, unknown>>(c, "DELETE", `/api/promo/watch-list/${offerId}`),
  searchCompetitors: (c: ApiConfig, query: string) =>
    api<{ items: Array<{ offerId: string; name: string; price: number; rating: number; salesCount: number }> }>(
      c, "GET", `/api/ozon/products/search?query=${encodeURIComponent(query)}&limit=10`,
    ),
  savePrices: (c: ApiConfig, offerId: string, prices: Array<{ price: number; rating: number; salesCount: number; capturedAt: string }>) =>
    api<Record<string, unknown>>(c, "POST", `/api/promo/competitor-prices/${offerId}`, { prices }),
  getPrices: (c: ApiConfig, offerId: string, days?: number) =>
    api<{ prices: Array<{ price: number; rating: number; salesCount: number; capturedAt: string }> }>(
      c, "GET", `/api/promo/competitor-prices/${offerId}?days=${days || 7}`,
    ),
  getScraperStatus: (c: ApiConfig) => api<{ status: string; blockedUntil?: string }>(c, "GET", "/api/scraper/status"),
  postEvent: (c: ApiConfig, event: { type: string; payload?: Record<string, unknown> }) =>
    api<Record<string, unknown>>(c, "POST", "/api/promo/events", event),
  getEvents: (c: ApiConfig, eventType: string) =>
    api<{ events: Array<{ type: string; payload: Record<string, unknown>; createdAt: string }> }>(
      c, "GET", `/api/promo/events?type=${encodeURIComponent(eventType)}`,
    ),
};

// ---- 复用 ops-agent 运维 API ----
export const opsApi = {
  health: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/health"),
  ready: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/ready"),
  diagnose: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/diagnose"),
  systemLoad: (c: ApiConfig) =>
    api<{ cpu: number; memory: number; activeConnections: number }>(
      c, "GET", "/api/system/load",
    ),
  validatePromoAction: (c: ApiConfig, action: { type: string; offerId: string }) =>
    api<{ allowed: boolean; reason?: string }>(
      c, "POST", "/api/promo/validate", action,
    ),
};

// ---- 统计与效果追踪 API ----
export const statsApi = {
  daily: (c: ApiConfig, date: string) =>
    api<{
      orders: number;
      revenue: number;
      avgOrderValue: number;
      topProducts: Array<{ offerId: string; name: string; orders: number; revenue: number }>;
    }>(c, "GET", `/api/stats/daily?date=${date}`),
  weekly: (c: ApiConfig, from: string, to: string) =>
    api<{
      orders: number;
      revenue: number;
      byDay: Array<{ date: string; orders: number; revenue: number }>;
      top5: Array<{ offerId: string; name: string; orders: number; revenue: number }>;
      bottom5: Array<{ offerId: string; name: string; orders: number; stock: number }>;
    }>(c, "GET", `/api/stats/weekly?from=${from}&to=${to}`),
  pricingHistory: (c: ApiConfig, days?: number) =>
    api<{
      adjustments: Array<{
        offerId: string; name: string; oldPrice: number; newPrice: number;
        reason: string; appliedAt: string; salesAfter: number;
      }>;
    }>(c, "GET", `/api/promo/pricing-history?days=${days || 7}`),
  copyHistory: (c: ApiConfig, days?: number) =>
    api<{
      copies: Array<{
        offerId: string; name: string; appliedAt: string; salesAfter: number;
      }>;
    }>(c, "GET", `/api/promo/copy-history?days=${days || 7}`),
  promoCost: (c: ApiConfig, from: string, to: string) =>
    api<{
      adSpend: number;
      totalRevenue: number;
      organicRevenue: number;
      paidRevenue: number;
      roi: number;
    }>(c, "GET", `/api/promo/cost?from=${from}&to=${to}`),
};
