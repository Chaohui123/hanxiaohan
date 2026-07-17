// ============================================================
// Proxy Manager — IP pool with health checks and auto-rotation
// Supports: static proxy list, API-based proxy fetching
// ============================================================

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface ProxyStats {
  server: string;
  totalRequests: number;
  failedRequests: number;
  lastUsed: number;
  lastFailed: number;
  healthy: boolean;
  failRate: number;
}

export class ProxyManager {
  private proxies: ProxyConfig[] = [];
  private stats = new Map<string, ProxyStats>();
  private currentIndex = 0;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.loadProxies();
    this.startHealthCheck();
  }

  /** Get the next healthy proxy (round-robin). Returns null if no proxies configured. */
  getProxy(): ProxyConfig | null {
    if (this.proxies.length === 0) return null;

    // Filter healthy proxies
    const healthy = this.proxies.filter((p) => {
      const s = this.stats.get(p.server);
      return s ? s.healthy : true;
    });

    if (healthy.length === 0) {
      // All proxies unhealthy — reset and retry all
      for (const [server, stat] of this.stats) {
        stat.healthy = true;
        stat.failedRequests = 0;
      }
      return this.proxies[this.currentIndex++ % this.proxies.length];
    }

    const proxy = healthy[this.currentIndex++ % healthy.length];
    this.recordUsage(proxy.server);
    return proxy;
  }

  /** Mark a proxy as failed. Auto-ejects after 3 consecutive failures. */
  markFailed(server: string): void {
    let s = this.stats.get(server);
    if (!s) {
      s = { server, totalRequests: 0, failedRequests: 0, lastUsed: Date.now(), lastFailed: Date.now(), healthy: true, failRate: 0 };
      this.stats.set(server, s);
    }
    s.failedRequests++;
    s.totalRequests++;
    s.lastFailed = Date.now();
    s.failRate = s.totalRequests > 0 ? s.failedRequests / s.totalRequests : 1;

    if (s.failedRequests >= 3 || s.failRate > 0.5) {
      s.healthy = false;
      console.warn(`[ProxyManager] Proxy ${server} marked UNHEALTHY (${s.failedRequests} failures, ${(s.failRate * 100).toFixed(0)}% fail rate)`);
    }

    // If all proxies are unhealthy, reset all
    if (this.proxies.length > 0 && [...this.stats.values()].every((x) => !x.healthy)) {
      console.warn("[ProxyManager] All proxies unhealthy — resetting all");
      for (const [, stat] of this.stats) {
        stat.healthy = true;
        stat.failedRequests = 0;
      }
    }
  }

  /** Mark a proxy request as successful. */
  markSuccess(server: string): void {
    let s = this.stats.get(server);
    if (!s) {
      s = { server, totalRequests: 0, failedRequests: 0, lastUsed: Date.now(), lastFailed: 0, healthy: true, failRate: 0 };
      this.stats.set(server, s);
    }
    s.totalRequests++;
    s.lastUsed = Date.now();
    s.failRate = s.totalRequests > 0 ? s.failedRequests / s.totalRequests : 0;

    // Recover: if failRate drops below 30%, mark healthy again
    if (!s.healthy && s.failRate < 0.3 && s.failedRequests < 3) {
      s.healthy = true;
      console.log(`[ProxyManager] Proxy ${server} recovered (failRate: ${(s.failRate * 100).toFixed(0)}%)`);
    }
  }

  /** Get all proxy stats for monitoring. */
  getStats(): ProxyStats[] {
    // Include proxies that haven't been used yet
    for (const p of this.proxies) {
      if (!this.stats.has(p.server)) {
        this.stats.set(p.server, { server: p.server, totalRequests: 0, failedRequests: 0, lastUsed: 0, lastFailed: 0, healthy: true, failRate: 0 });
      }
    }
    return [...this.stats.values()];
  }

  /** Get monitoring summary. */
  getMetrics() {
    const allStats = this.getStats();
    const total = allStats.length;
    const healthy = allStats.filter((s) => s.healthy).length;
    const totalRequests = allStats.reduce((sum, s) => sum + s.totalRequests, 0);
    const totalFailures = allStats.reduce((sum, s) => sum + s.failedRequests, 0);

    return {
      proxyCount: total,
      healthyProxies: healthy,
      unhealthyProxies: total - healthy,
      totalRequests,
      totalFailures,
      overallSuccessRate: totalRequests > 0 ? ((totalRequests - totalFailures) / totalRequests * 100).toFixed(1) + "%" : "N/A",
    };
  }

  /** Cleanup interval timer. */
  destroy(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  // ---- Private ----

  private recordUsage(server: string): void {
    if (!this.stats.has(server)) {
      this.stats.set(server, { server, totalRequests: 0, failedRequests: 0, lastUsed: Date.now(), lastFailed: 0, healthy: true, failRate: 0 });
    }
  }

  private loadProxies(): void {
    // Static proxy list from env
    const list = process.env.SCRAPER_PROXY_LIST || "";
    if (list) {
      for (const entry of list.split(",").map((s) => s.trim()).filter(Boolean)) {
        try {
          const url = new URL(entry);
          this.proxies.push({
            server: `${url.protocol}//${url.hostname}:${url.port || "80"}`,
            username: url.username || undefined,
            password: url.password || undefined,
          });
        } catch {
          // Plain ip:port format
          const [host, port] = entry.split(":");
          this.proxies.push({ server: `http://${host}:${port || "80"}` });
        }
      }
      console.log(`[ProxyManager] Loaded ${this.proxies.length} proxies from SCRAPER_PROXY_LIST`);
    }

    // API-based proxy fetching (runs on first getProxy call)
    if (process.env.SCRAPER_PROXY_API_URL) {
      this.fetchProxiesFromApi().catch(() => {});
    }
  }

  private async fetchProxiesFromApi(): Promise<void> {
    const apiUrl = process.env.SCRAPER_PROXY_API_URL;
    if (!apiUrl) return;

    try {
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as Record<string, unknown>;
      const fetched: string[] = Array.isArray(data) ? data as unknown as string[] : ((data.data || data.proxies) as string[]) || [];

      for (const entry of fetched) {
        if (typeof entry === "string") {
          const [host, port] = entry.split(":");
          this.proxies.push({ server: `http://${host}:${port || "80"}` });
        } else if ((entry as Record<string, unknown>).server || (entry as Record<string, unknown>).ip) {
          const e = entry as Record<string, string>;
          const server = e.server || `http://${e.ip}:${e.port || "80"}`;
          this.proxies.push({ server, username: e.username || e.user, password: e.password || e.pass });
        }
      }

      console.log(`[ProxyManager] Fetched ${fetched.length} proxies from API`);
    } catch (err) {
      console.warn(`[ProxyManager] Failed to fetch proxies from API: ${(err as Error).message}`);
    }
  }

  private startHealthCheck(): void {
    // Every 5 minutes, reset healthy status on long-unused proxies
    this.checkTimer = setInterval(() => {
      const now = Date.now();
      for (const [server, stat] of this.stats) {
        // If proxy hasn't been used in 30 min and is unhealthy, try it again
        if (!stat.healthy && now - stat.lastUsed > 30 * 60_000) {
          stat.healthy = true;
          stat.failedRequests = 0;
          console.log(`[ProxyManager] Proxy ${server} cooled down — re-enabled`);
        }
      }
    }, 300_000);
  }
}
