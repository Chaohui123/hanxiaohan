// ============================================================
// Pipeline Health Check — external dependency availability
// Used by /health and /ready endpoints for diagnostics
// ============================================================

export interface ComponentStatus {
  name: string;
  status: "ok" | "degraded" | "down";
  latencyMs: number;
  message?: string;
}

export interface PipelineHealth {
  status: "healthy" | "degraded" | "unhealthy";
  components: ComponentStatus[];
  checkedAt: string;
}

/**
 * Check all external dependencies used by the listing pipeline.
 */
export async function checkPipelineHealth(): Promise<PipelineHealth> {
  const components: ComponentStatus[] = [];
  const start = Date.now();

  // 1. Ozon API
  try {
    const t0 = Date.now();
    const res = await fetch("https://api-seller.ozon.ru/v1/warehouse/list", {
      method: "POST",
      headers: {
        "Client-Id": process.env.OZON_CLIENT_IDS || "",
        "Api-Key": process.env.OZON_API_KEYS || "",
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    const latency = Date.now() - t0;
    components.push({
      name: "ozon-api",
      status: res.ok || res.status === 400 ? "ok" : "degraded",
      latencyMs: latency,
      message: res.status === 400 ? "Auth OK (400 expected)" : undefined,
    });
  } catch (err) {
    components.push({ name: "ozon-api", status: "down", latencyMs: 0, message: (err as Error).message });
  }

  // 2. DeepSeek API
  try {
    const t0 = Date.now();
    const res = await fetch("https://api.deepseek.com/v1/models", {
      headers: { "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY || ""}` },
      signal: AbortSignal.timeout(10_000),
    });
    components.push({
      name: "deepseek-api",
      status: res.ok ? "ok" : "degraded",
      latencyMs: Date.now() - t0,
      message: res.ok ? undefined : `HTTP ${res.status}`,
    });
  } catch (err) {
    components.push({ name: "deepseek-api", status: "down", latencyMs: 0, message: (err as Error).message });
  }

  // 3. Kimi K3 vision API
  try {
    const t0 = Date.now();
    const res = await fetch(`${process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1"}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.KIMI_API_KEY || ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: process.env.KIMI_VISION_MODEL || "kimi-k3", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    components.push({
      name: "kimi-api",
      status: res.ok || res.status === 429 ? "ok" : "degraded",
      latencyMs: Date.now() - t0,
      message: res.status === 429 ? "Rate limited but reachable" : undefined,
    });
  } catch (err) {
    components.push({ name: "kimi-api", status: "down", latencyMs: 0, message: (err as Error).message });
  }

  // 4. Proxy Pool (if configured)
  if (process.env.SCRAPER_PROXY_LIST || process.env.SCRAPER_PROXY_API_URL) {
    try {
      const { ProxyManager } = await import("@onzo/scraper-1688");
      const pm = new ProxyManager();
      const metrics = pm.getMetrics();
      components.push({
        name: "proxy-pool",
        status: metrics.healthyProxies > 0 ? "ok" : "degraded",
        latencyMs: 0,
        message: `${metrics.healthyProxies}/${metrics.proxyCount} healthy`,
      });
      pm.destroy();
    } catch {
      components.push({ name: "proxy-pool", status: "degraded", latencyMs: 0, message: "Configured but check failed" });
    }
  }

  // 5. Playwright / Browser
  try {
    const t0 = Date.now();
    let browserOk = false;
    try {
      // @ts-expect-error — playwright is optional (Phase 2+), not installed by default
      const pw = await import("playwright");
      const browser = await pw.chromium.launch({ headless: true });
      await browser.close();
      browserOk = true;
    } catch { /* browser not available */ }
    components.push({
      name: "playwright-browser",
      status: browserOk ? "ok" : "degraded",
      latencyMs: Date.now() - t0,
      message: browserOk ? undefined : "Chromium not installed (use ENV=dev + ENABLE_MOCK for testing)",
    });
  } catch {
    components.push({ name: "playwright-browser", status: "degraded", latencyMs: 0, message: "Playwright not installed" });
  }

  // Determine overall status
  const downCount = components.filter((c) => c.status === "down").length;
  const degradedCount = components.filter((c) => c.status === "degraded").length;

  return {
    status: downCount > 0 ? "unhealthy" : degradedCount > 1 ? "degraded" : "healthy",
    components,
    checkedAt: new Date().toISOString(),
  };
}
