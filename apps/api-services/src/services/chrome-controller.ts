// ============================================================
// Chrome Controller — CDP-based headless browser automation
// Drives Chromium to automate 1688 plugin download workflow.
// Uses chrome-remote-interface (Chrome DevTools Protocol).
// ============================================================

import { logger } from "@onzo/logger";

const DEFAULT_DEBUG_PORT = parseInt(process.env.CHROMIUM_DEBUG_PORT || "9222", 10);
const DEFAULT_TIMEOUT = parseInt(process.env.PLUGIN_DOWNLOAD_TIMEOUT_MS || "60000", 10);

interface CDPClient {
  Network: { enable: () => Promise<void>; setUserAgentOverride: (opts: { userAgent: string }) => Promise<void> };
  Page: {
    enable: () => Promise<void>;
    navigate: (opts: { url: string }) => Promise<{ frameId: string }>;
    loadEventFired: () => Promise<void>;
    captureScreenshot: (opts?: { format?: string }) => Promise<{ data: string }>;
  };
  Runtime: {
    enable: () => Promise<void>;
    evaluate: (opts: { expression: string; awaitPromise?: boolean }) => Promise<{ result: { value?: unknown } }>;
  };
  Browser: { getVersion: () => Promise<{ product: string }> };
  close: () => Promise<void>;
}

export interface ChromeControllerOptions {
  debugPort?: number;
  timeout?: number;
}

export interface ExtractedProduct {
  title: string;
  priceCny: number;
  images: string[];
  specs: Array<{ name: string; value: string }>;
  description?: string;
}

export class ChromeController {
  private debugPort: number;
  private timeout: number;
  private client: CDPClient | null = null;
  private connected = false;

  constructor(options: ChromeControllerOptions = {}) {
    this.debugPort = options.debugPort ?? DEFAULT_DEBUG_PORT;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  /** Connect to headless Chromium via CDP */
  async connect(): Promise<boolean> {
    if (this.connected) return true;
    try {
      const CDP = await import("chrome-remote-interface");
      this.client = await CDP.default({ port: this.debugPort }) as unknown as CDPClient;
      await this.client.Network.enable();
      await this.client.Page.enable();
      await this.client.Runtime.enable();

      // Set realistic browser fingerprint
      await this.client.Network.setUserAgentOverride({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      });

      const version = await this.client.Browser.getVersion();
      logger.info({ version: version.product, debugPort: this.debugPort }, "ChromeController: CDP connected");
      this.connected = true;
      return true;
    } catch (err) {
      logger.warn({ err: (err as Error).message, debugPort: this.debugPort }, "ChromeController: CDP connection failed");
      return false;
    }
  }

  /** Check if Chromium debug port is reachable */
  async isBrowserAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`http://localhost:${this.debugPort}/json/version`, {
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Navigate to a 1688 product page and extract product data */
  async extractProduct(url: string): Promise<ExtractedProduct | null> {
    if (!this.client || !this.connected) {
      const ok = await this.connect();
      if (!ok) return null;
    }

    try {
      // Navigate
      await this.client!.Page.navigate({ url });
      await this.withTimeout(this.waitForLoad(), this.timeout, "Page load timeout");

      // Extract product data via JS evaluation
      const result = await this.client!.Runtime.evaluate({
        expression: `
          (function() {
            try {
              const title = document.querySelector('h1[data-testid="product-title"], .offer-title, h1')?.textContent?.trim() || '';
              const priceEl = document.querySelector('.price-original, .price, [data-testid="price"]');
              const priceText = priceEl?.textContent?.replace(/[^0-9.]/g, '') || '0';
              const images = Array.from(document.querySelectorAll('.detail-gallery-img img, .swiper-slide img, [data-role="thumb"] img'))
                .map(img => img.src || img.getAttribute('data-src'))
                .filter(src => src && src.startsWith('http'));
              const specRows = document.querySelectorAll('.offer-attr-item, .spec-item, tr');
              const specs = [];
              specRows.forEach(row => {
                const name = row.querySelector('.name, .attr-name, th')?.textContent?.trim();
                const value = row.querySelector('.value, .attr-value, td')?.textContent?.trim();
                if (name && value) specs.push({ name, value });
              });
              return JSON.stringify({ title, priceCny: parseFloat(priceText), images: [...new Set(images)], specs });
            } catch(e) { return JSON.stringify({ error: e.message }); }
          })()
        `,
        awaitPromise: false,
      });

      const raw = result.result.value;
      if (typeof raw !== "string") return null;
      const data = JSON.parse(raw) as ExtractedProduct & { error?: string };
      if (data.error) {
        logger.warn({ url, error: data.error }, "ChromeController: extraction failed");
        return null;
      }
      return { title: data.title, priceCny: data.priceCny, images: data.images, specs: data.specs };
    } catch (err) {
      logger.warn({ url, err: (err as Error).message }, "ChromeController: extractProduct failed");
      return null;
    }
  }

  /** Download image binaries via CDP Network interception */
  async downloadImages(imageUrls: string[], onProgress?: (pct: number) => void): Promise<Array<{ url: string; buffer: Buffer }>> {
    const results: Array<{ url: string; buffer: Buffer }> = [];
    let downloaded = 0;

    for (const url of imageUrls) {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://detail.1688.com/",
            "Accept": "image/avif,image/webp,image/*",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          results.push({ url, buffer: buf });
        }
      } catch {
        // Skip failed images
      }
      downloaded++;
      onProgress?.(Math.round((downloaded / imageUrls.length) * 100));
    }
    return results;
  }

  /** Disconnect from Chromium */
  async disconnect(): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ok */ }
      this.client = null;
    }
    this.connected = false;
  }

  // ---- Private ----

  private async waitForLoad(): Promise<void> {
    // Wait for page load event
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 15_000);
      const check = setInterval(async () => {
        try {
          const result = await this.client!.Runtime.evaluate({
            expression: "document.readyState",
            awaitPromise: false,
          });
          if (result.result.value === "complete") {
            clearTimeout(timeout);
            clearInterval(check);
            resolve();
          }
        } catch { /* retry */ }
      }, 500);
    });
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
}

// Singleton
let _instance: ChromeController | null = null;

export function getChromeController(): ChromeController {
  if (!_instance) _instance = new ChromeController();
  return _instance;
}
