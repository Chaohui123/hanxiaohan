
export interface ApiConfig {
  apiBase: string;
  apiKey: string;
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
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

export const apiClient = {
  health: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/health"),
  ready: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/ready"),
  diagnose: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/diagnose"),
  dashboard: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/dashboard"),
  orders: (c: ApiConfig, status?: string) =>
    api<Record<string, unknown>>(c, "GET", `/api/orders${status ? `?status=${status}` : ""}`),
  inventoryAlerts: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/inventory/alerts"),
  llmStats: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/stats/llm"),
  taskStats: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/task/queue/stats"),
  syncOrders: (c: ApiConfig) => api<Record<string, unknown>>(c, "POST", "/api/orders/sync"),
  backup: (c: ApiConfig) => api<Record<string, unknown>>(c, "POST", "/api/db/backup"),
  cleanup: (c: ApiConfig) => api<Record<string, unknown>>(c, "POST", "/api/ops/cleanup"),
  healthPanel: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/api/ops/health-panel"),
  reconcile: (c: ApiConfig, dateFrom: string, dateTo: string) =>
    api<Record<string, unknown>>(c, "POST", "/api/orders/reconcile", { dateFrom, dateTo }),
  pipelineHealth: (c: ApiConfig) => api<Record<string, unknown>>(c, "GET", "/ready/pipeline"),
  /** 提交1688链接上架 */
  submitListing: (c: ApiConfig, sourceUrl: string) =>
    api<Record<string, unknown>>(c, "POST", "/api/process", { sourceUrl, storeId: "store_1" }),
  /** 查询上架进度 */
  taskProgress: (c: ApiConfig, taskId: string) =>
    api<Record<string, unknown>>(c, "GET", `/api/task/${taskId}`),
  /** 查询最近上架记录 */
  recentListings: (c: ApiConfig, limit = 5) =>
    api<Record<string, unknown>>(c, "GET", `/api/process/recent?limit=${limit}`),
};
