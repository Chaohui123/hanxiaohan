import axios from "axios";

const AUTH_KEY = "onzo-api-key";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || "",
  timeout: 30_000,
  headers: { "Content-Type": "application/json" },
});

// ---- Request interceptor: inject API key from localStorage or env var ----
api.interceptors.request.use((config) => {
  let apiKey = "";
  try { apiKey = localStorage.getItem(AUTH_KEY) || ""; } catch {}

  // Fallback to build-time env var for dev convenience
  if (!apiKey) {
    apiKey = import.meta.env.VITE_API_KEY || "";
  }

  if (apiKey) {
    config.headers["X-API-Key"] = apiKey;
  }

  return config;
});

// Phase 2 (JWT): replace X-API-Key with Bearer token from localStorage.
// Refresh flow: on 401, call /api/auth/refresh → store new token → retry original.

// ---- Response interceptor: 401 → redirect to login ----
api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const msg = err.response?.data?.error?.message || err.message;

    // 401 — clear stored key and redirect to login
    if (err.response?.status === 401) {
      try { localStorage.removeItem(AUTH_KEY); } catch {}
      if (window.location.pathname !== "/login") {
        window.location.href = "/login?reason=auth_required&message=" + encodeURIComponent(msg);
      }
    }

    return Promise.reject(new Error(msg));
  }
);

// ---- Product Listing ----
export const listingApi = {
  submit: (url: string) => api.post("/api/process", { url }),
  submitSync: (url: string) => api.post("/api/process/sync", { url }),
  manual: (data: Record<string, unknown>) => api.post("/api/process/manual", data),
  debugScrape: (url: string) => api.get("/api/debug/scrape", { params: { url } }),
};

// ---- Dashboard ----
export const dashboardApi = {
  stats: () => api.get("/api/dashboard"),
  globalStats: () => api.get("/api/dashboard/global"),
  alerts: () => api.get("/api/dashboard/alerts"),
  cosStats: () => api.get("/api/dashboard/cos"),
  taskList: (status?: string) => api.get("/api/dashboard/tasks", { params: { status } }),
  health: () => api.get("/health"),
  ready: () => api.get("/ready"),
};

// ---- Orders ----
export const orderApi = {
  list: (status?: string) => api.get("/api/orders", { params: { status } }),
  sync: (params?: Record<string, unknown>) => api.post("/api/orders/sync", params || {}),
  ship: (postingNumber: string, trackingNumber: string, products: Array<{ sku: number; quantity: number }>) =>
    api.post("/api/orders/ship", { postingNumber, trackingNumber, products }),
  batchShip: () => api.post("/api/orders/batch-ship", {}),
  metrics: () => api.get("/api/orders/metrics"),
};

// ---- Tasks ----
export const taskApi = {
  queueStats: () => api.get("/api/task/queue/stats"),
  queue: (status?: string) => api.get("/api/task/queue", { params: { status } }),
  failed: (storeId?: string) => api.get("/api/task/failed", { params: { storeId } }),
  retry: (taskId: string) => api.post(`/api/task/retry/${taskId}`),
  retryBatch: (filterType: string) => api.post("/api/task/deadletter/retry-batch", { filterType }),
  listings: () => api.get("/api/task/listings"),
};

// ---- Inventory ----
export const inventoryApi = {
  items: () => api.get("/api/inventory/items"),
  alerts: () => api.get("/api/inventory/alerts"),
  restock: () => api.get("/api/inventory/recommendations"),
};

// ---- Stores ----
export const storeApi = {
  list: () => api.get("/api/stores"),
  create: (data: Record<string, unknown>) => api.post("/api/stores", data),
  delete: (id: string) => api.delete(`/api/stores/${id}`),
  summary: () => api.get("/api/stores/summary"),
};

// ---- Monitoring ----
export const monitorApi = {
  llmStats: () => api.get("/api/stats/llm"),
  cosStats: () => api.get("/api/stats/cos"),
  fxRate: () => api.get("/api/stores/fx"),
  scraperMetrics: () => api.get("/api/debug/scraper-metrics"),
  pipelineHealth: () => api.get("/ready/pipeline"),
};

// ---- Aftersales ----
export const aftersalesApi = {
  list: () => api.get("/api/aftersales/cases"),
  create: (data: Record<string, unknown>) => api.post("/api/aftersales/cases", data),
  update: (id: string, data: Record<string, unknown>) => api.post(`/api/aftersales/cases/${id}`, data),
};

// ---- Analyze ----
export const analyzeApi = {
  blueOcean: () => api.get("/api/analyze/blue-ocean"),
};
