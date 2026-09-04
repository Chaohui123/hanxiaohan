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

/**
 * 后端 { success, data } 业务信封的脱壳（响应拦截器已脱 axios 层，这里再脱业务层）。
 * 页面/组件拿到的就是最终数据，不再自行判断信封。
 * 注意：返回裸对象的端点（/api/promo/*、/api/stats/weekly、/api/stores/fx、/ready/pipeline、
 * /api/rag/* 等）不要走这里，在 api 方法里直接 `as unknown as Promise<T>`。
 */
export function unwrapData<T>(p: Promise<unknown>): Promise<T> {
  return (p as Promise<{ data: T }>).then((r) => r.data);
}
