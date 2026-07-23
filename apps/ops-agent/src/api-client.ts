
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
  submitListing: (c: ApiConfig, url: string) =>
    api<Record<string, unknown>>(c, "POST", "/api/process", { url, storeId: "store_1" }),
  /** 查询上架进度（/api/task/:id 不存在 — filter the queue list by id instead） */
  taskProgress: async (c: ApiConfig, taskId: string) => {
    const res = await api<{ data?: Array<Record<string, unknown>> }>(c, "GET", `/api/task/queue?limit=500`);
    const task = (res.data ?? []).find((t) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    return task;
  },
  /** 查询最近上架记录（/api/process/recent 不存在 — use /api/task/listings） */
  recentListings: (c: ApiConfig, limit = 5) =>
    api<Record<string, unknown>>(c, "GET", `/api/task/listings?limit=${limit}`),
  /** 触发 1688 官方插件下载详情页/图/SKU（采购铺垫素材记录） */
  pluginReDownload: (c: ApiConfig, url: string, keyword?: string) =>
    api<Record<string, unknown>>(c, "POST", "/api/plugin/re-download", { url, keyword: keyword || "" }),
};
