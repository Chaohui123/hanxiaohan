// ============================================================
// 1688 Product Scraper — Playwright-based
// ============================================================

import type { ScrapedProduct } from "@onzo/shared-types";
import { parseProductPage, sanitizeUrl } from "./parser.js";
import { createStealthConfig, randomDelay, sleep } from "./anti-detect.js";
import { ProxyManager } from "./proxy-manager.js";
import { CaptchaHandler } from "./captcha-handler.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load browser scripts as raw strings to avoid tsx/esbuild transpilation
const SCRIPTS_DIR = join(__dirname, "scripts");
const EXTRACT_PAGE_DATA_SCRIPT = readFileSync(join(SCRIPTS_DIR, "extract-page-data.js"), "utf-8");
const EXTRACT_DETAIL_IMAGES_SCRIPT = readFileSync(join(SCRIPTS_DIR, "extract-detail-images.js"), "utf-8");
const SCROLL_TO_LOAD_SCRIPT = readFileSync(join(SCRIPTS_DIR, "scroll-to-load.js"), "utf-8");

// Startup validation
if (!EXTRACT_PAGE_DATA_SCRIPT || EXTRACT_PAGE_DATA_SCRIPT.length < 50) {
  console.error("[Scraper] FATAL: extract-page-data.js is empty or missing!", { dir: SCRIPTS_DIR });
}
console.log("[Scraper] Browser scripts loaded:", {
  extractPageData: EXTRACT_PAGE_DATA_SCRIPT.length,
  extractDetailImages: EXTRACT_DETAIL_IMAGES_SCRIPT.length,
  scrollToLoad: SCROLL_TO_LOAD_SCRIPT.length,
});

import type { Browser, BrowserContext, Page, ChromiumBrowserContext } from "playwright";

let _chromium: typeof import("playwright").chromium | null = null;

async function ensurePlaywright() {
  if (!_chromium) {
    const pw = await import("playwright");
    _chromium = pw.chromium;
  }
  return _chromium;
}

// ============================================================
// BrowserPool — limits concurrent Playwright instances
// Prevents memory overflow from parallel scraping tasks
// ============================================================

export interface BrowserPoolConfig {
  maxBrowsers: number;
  maxPagesPerBrowser?: number;
}

export class BrowserPool {
  private maxBrowsers: number;
  private maxPagesPerBrowser: number;
  private activeBrowsers = 0;
  private waitQueue: Array<() => void> = [];

  constructor(config?: BrowserPoolConfig) {
    this.maxBrowsers = config?.maxBrowsers ?? 2;
    this.maxPagesPerBrowser = config?.maxPagesPerBrowser ?? 5;
  }

  /** Acquire a browser slot. Blocks if at capacity. */
  async acquire(): Promise<void> {
    if (this.activeBrowsers < this.maxBrowsers) {
      this.activeBrowsers++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.activeBrowsers++;
        resolve();
      });
    });
  }

  /** Release a browser slot. */
  release(): void {
    this.activeBrowsers--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  get active(): number { return this.activeBrowsers; }
  get queued(): number { return this.waitQueue.length; }
  get capacity(): number { return this.maxBrowsers; }
}

export interface ScraperConfig {
  headless?: boolean;
  timeout?: number;
  proxy?: { server: string; username?: string; password?: string };
  dataDir?: string; // persistent browser context
  cookieFile?: string; // path to save/load cookies (JSON)
  minDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_CONFIG: Required<Omit<ScraperConfig, "proxy">> = {
  headless: true,
  timeout: 30000,
  dataDir: "./data/browser",
  cookieFile: "./data/browser/cookies.json",
  minDelayMs: 3000,
  maxDelayMs: 8000,
};

export class ProductScraper {
  private config: Required<Omit<ScraperConfig, "proxy">> & { proxy?: ScraperConfig["proxy"] };
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private proxyManager: ProxyManager;
  private captchaHandler: CaptchaHandler;
  private scraperMetrics = { totalRequests: 0, successRequests: 0, failedRequests: 0, captchaTriggers: 0, totalDurationMs: 0 };

  constructor(config?: ScraperConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.proxyManager = new ProxyManager();
    this.captchaHandler = new CaptchaHandler();
  }

  /** Attach captcha notification callback. */
  onCaptcha(fn: (event: import("./captcha-handler.js").CaptchaEvent) => Promise<void>): void {
    this.captchaHandler.onCaptcha(fn);
  }

  /** Get proxy stats + scraper metrics for monitoring. */
  getMetrics() {
    return {
      ...this.scraperMetrics,
      successRate: this.scraperMetrics.totalRequests > 0
        ? (this.scraperMetrics.successRequests / this.scraperMetrics.totalRequests * 100).toFixed(1) + "%"
        : "N/A",
      avgDurationMs: this.scraperMetrics.successRequests > 0
        ? Math.round(this.scraperMetrics.totalDurationMs / this.scraperMetrics.successRequests)
        : 0,
      proxy: this.proxyManager.getMetrics(),
      captcha: this.captchaHandler.metrics,
    };
  }

  /**
   * Scrape a single 1688 product URL with proxy rotation + captcha detection.
   * Retries up to 3 times with different proxies on failure.
   */
  async scrapeProduct(url: string, retries = 3): Promise<ScrapedProduct> {
    this.scraperMetrics.totalRequests++;
    const startTime = Date.now();

    // Check captcha cooldown
    if (this.captchaHandler.paused) {
      const remaining = this.captchaHandler.cooldownRemaining;
      throw new Error(`Scraper paused — captcha cooldown active (${remaining}s remaining). Please wait or resolve captcha manually.`);
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Rotate proxy on retry
        if (attempt > 0) {
          await this.close(); // Close old browser context
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10_000);
          await sleep(backoffMs);
        }

        await this.ensureBrowser();
        console.log(`[Scraper] Attempt ${attempt + 1}/${retries}, navigating to:`, url);

        const page = await this.context!.newPage();
        try {
          await sleep(randomDelay(this.config.minDelayMs, this.config.maxDelayMs));

          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60_000, // 60s timeout
          });
          console.log("[Scraper] Page loaded:", await page.title());

          // Captcha check
          const captcha = await this.captchaHandler.detect(page);
          if (captcha) {
            this.scraperMetrics.captchaTriggers++;
            this.proxyManager.markFailed(this.config.proxy?.server || "direct");
            throw new Error(`Captcha detected: ${captcha.captchaType}. Scraper entering cooldown.`);
          }

          try {
            await page.waitForSelector(".mod-detail, .offer-detail, .tab-content-container, [data-mod-config]", {
              timeout: 10000,
            });
          } catch {
            // continue
          }

          await this.dismissLoginOverlay(page);
          await this.scrollToLoad(page);

          const pageData = await this.extractPageData(page, url);
          const detailImages = await this.extractDetailImages(page);

          const product = parseProductPage(pageData, url);
          product.detailImages = detailImages;

          await this.saveCookies().catch(() => {});
          this.proxyManager.markSuccess(this.config.proxy?.server || "direct");

          // Update metrics
          this.scraperMetrics.successRequests++;
          this.scraperMetrics.totalDurationMs += (Date.now() - startTime);

          return product;
        } finally {
          await page.close();
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[Scraper] Attempt ${attempt + 1} failed: ${lastError.message}`);

        if (attempt < retries - 1) {
          // Switch proxy for retry
          const newProxy = this.proxyManager.getProxy();
          if (newProxy) {
            this.config.proxy = newProxy;
            console.log(`[Scraper] Switching proxy to ${newProxy.server}`);
          }
        }
      }
    }

    this.scraperMetrics.failedRequests++;
    throw lastError!;
  }

  /**
   * Scrape multiple URLs sequentially with rate limiting.
   */
  async scrapeBatch(urls: string[], concurrency: number = 1): Promise<ScrapedProduct[]> {
    const results: ScrapedProduct[] = [];

    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map((url) => this.scrapeProduct(url))
      );

      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          console.error(`Scrape failed for a URL: ${result.reason?.message}`);
          // Continue with other URLs
        }
      }
    }

    return results;
  }

  /**
   * Download images from URLs, returning buffers.
   * Adds 1688 Referer header to bypass hotlink protection.
   */
  async downloadImages(
    imageUrls: string[],
    concurrency: number = 3
  ): Promise<Array<{ url: string; buffer: Buffer; contentType: string }>> {
    const results: Array<{ url: string; buffer: Buffer; contentType: string }> = [];
    const uniqueUrls = [...new Set(imageUrls)];

    for (let i = 0; i < uniqueUrls.length; i += concurrency) {
      const batch = uniqueUrls.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map(async (url) => {
          const response = await fetch(url, {
            headers: {
              "Referer": "https://detail.1688.com/",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
              "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const contentType = response.headers.get("content-type") || "image/jpeg";
          return { url, buffer, contentType };
        })
      );

      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        }
      }
    }

    return results;
  }

  /**
   * Download images via Playwright browser — uses existing 1688 cookies/session
   * to bypass hotlink protection that blocks plain fetch requests.
   * Returns only successfully downloaded images (with content-type validation).
   */
  async downloadImagesViaBrowser(
    imageUrls: string[],
    options?: { maxImages?: number; minWidth?: number; minHeight?: number }
  ): Promise<Array<{ url: string; buffer: Buffer; contentType: string }>> {
    const maxImages = options?.maxImages ?? 15;
    await this.ensureBrowser();

    const page = await this.context!.newPage();
    const results: Array<{ url: string; buffer: Buffer; contentType: string }> = [];
    const uniqueUrls = [...new Set(imageUrls)];

    try {
      for (const url of uniqueUrls) {
        if (results.length >= maxImages) break;

        try {
          // Use Playwright's request interception to capture the image response
          const response = await page.goto(url, {
            waitUntil: "commit",
            timeout: 15000,
          });

          if (!response || !response.ok()) continue;

          const contentType = response.headers()["content-type"] || "";
          // Only accept actual images, not HTML pages
          if (!contentType.startsWith("image/")) continue;

          const buffer = await response.body();
          if (!buffer || buffer.length < 1024) continue; // skip <1KB (icons/errors)

          results.push({ url, buffer, contentType });
        } catch {
          // Individual image failure — skip this URL, try next
        }
      }
    } finally {
      await page.close().catch(() => {});
    }

    return results;
  }

  /**
   * Filter raw scraped image URLs to keep only high-quality product images.
   * Removes: SVGs, icons, logos, badges, tiny images, non-product assets.
   */
  filterProductImages(imageUrls: string[]): string[] {
    return imageUrls.filter((url) => {
      const lower = url.toLowerCase();
      // Skip SVG icons
      if (lower.endsWith(".svg")) return false;
      // Skip icon-sized images (common in 1688: tps-15-14, tps-24-24, etc.)
      if (/tps-\d+-\d+/.test(lower)) return false;
      // Skip obvious badges/logos (contains "icon", "avatar", "logo", "badge", "banner")
      if (/\b(icon|avatar|logo|badge|banner|qr)\b/i.test(lower)) return false;
      // Skip "sum" (summary/thumbnail) images — usually duplicates
      if (/sum\.(jpg|png|webp)/i.test(lower)) return false;
      // Must be a real image format (with ?, &, _, /, #, or end-of-string after extension)
      return /\.(jpg|jpeg|png|webp)(\?|&|$|_|\/|#)/i.test(lower);
    });
  }

  /**
   * Clean up browser resources.
   */
  async close(): Promise<void> {
    // Persist cookies before closing
    if (this.context) {
      await this.saveCookies().catch(() => {});
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // ---- private ----

  private async ensureBrowser(): Promise<void> {
    if (this.browser && this.context) return;

    const chrome = await ensurePlaywright();

    // Get proxy from pool if not explicitly configured
    const proxy = this.config.proxy || this.proxyManager.getProxy() || undefined;

    this.browser = await chrome.launch({
      headless: this.config.headless,
      proxy: proxy as { server: string } | undefined,
    });

    this.context = await this.browser.newContext(createStealthConfig());

    // Load persisted cookies (1688 login session)
    await this.loadCookies();
  }

  /**
   * Load cookies from persisted file into the browser context.
   */
  private async loadCookies(): Promise<void> {
    const cookieFile = this.config.cookieFile;
    if (!cookieFile || !this.context) return;

    try {
      if (existsSync(cookieFile)) {
        const cookies = JSON.parse(readFileSync(cookieFile, "utf-8"));
        if (Array.isArray(cookies) && cookies.length > 0) {
          await this.context.addCookies(cookies);
          console.log(`[Scraper] Loaded ${cookies.length} cookies from ${cookieFile}`);
        }
      }
    } catch (err) {
      console.warn(`[Scraper] Failed to load cookies: ${(err as Error).message}`);
    }
  }

  /**
   * Save current browser context cookies to file.
   */
  private async saveCookies(): Promise<void> {
    const cookieFile = this.config.cookieFile;
    if (!cookieFile || !this.context) return;

    try {
      const cookies = await this.context.cookies();
      // Filter to only 1688 domain cookies to keep file small
      const relevantCookies = cookies.filter(
        (c) => c.domain.includes("1688") || c.domain.includes("taobao") || c.domain.includes("alibaba")
      );

      // Ensure directory exists
      const dir = dirname(cookieFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(cookieFile, JSON.stringify(relevantCookies.length > 0 ? relevantCookies : cookies, null, 2));
      console.log(`[Scraper] Saved ${relevantCookies.length} cookies to ${cookieFile}`);
    } catch (err) {
      console.warn(`[Scraper] Failed to save cookies: ${(err as Error).message}`);
    }
  }

  private async dismissLoginOverlay(page: Page): Promise<void> {
    try {
      // Try various close button selectors
      const closeSelectors = [
        ".login-dialog-close",
        ".close",
        '[class*="close"]',
        '[class*="cancel"]',
      ];

      for (const selector of closeSelectors) {
        const el = await page.$(selector);
        if (el) {
          await el.click();
          await sleep(500);
          break;
        }
      }

      // Also try pressing Escape
      await page.keyboard.press("Escape");
    } catch {
      // No overlay — continue
    }
  }

  private async scrollToLoad(page: Page): Promise<void> {
    await page.evaluate("(" + SCROLL_TO_LOAD_SCRIPT + ")()");
    await sleep(1000);
  }

  private async extractPageData(page: Page, _url: string): Promise<ExtractedPageData> {
    await page.addScriptTag({ content: "window.__extractPageData = " + EXTRACT_PAGE_DATA_SCRIPT + ";" });
    return page.evaluate("window.__extractPageData()") as Promise<ExtractedPageData>;
  }

  private async extractDetailImages(page: Page): Promise<string[]> {
    return page.evaluate("(" + EXTRACT_DETAIL_IMAGES_SCRIPT + ")()") as Promise<string[]>;
  }
}
