// ============================================================
// 1688 Product Scraper — Playwright-based
// ============================================================

import type { ScrapedProduct } from "@onzo/shared-types";
import { parseProductPage, sanitizeUrl } from "./parser.js";
import { createStealthConfig, randomDelay, sleep } from "./anti-detect.js";
import { readFileSync } from "node:fs";
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
  minDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_CONFIG: Required<Omit<ScraperConfig, "proxy">> = {
  headless: true,
  timeout: 30000,
  dataDir: "./data/browser",
  minDelayMs: 3000,
  maxDelayMs: 8000,
};

export class ProductScraper {
  private config: Required<Omit<ScraperConfig, "proxy">> & { proxy?: ScraperConfig["proxy"] };
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(config?: ScraperConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Scrape a single 1688 product URL.
   */
  async scrapeProduct(url: string): Promise<ScrapedProduct> {
    await this.ensureBrowser();
    console.log("[Scraper] Browser ready, navigating to:", url);

    const page = await this.context.newPage();
    try {
      await sleep(randomDelay(this.config.minDelayMs, this.config.maxDelayMs));

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.config.timeout,
      });
      console.log("[Scraper] Page loaded:", await page.title());

      try {
        await page.waitForSelector(".mod-detail, .offer-detail, .tab-content-container, [data-mod-config]", {
          timeout: 10000,
        });
      } catch {
        // continue
      }

      await this.dismissLoginOverlay(page);
      console.log("[Scraper] Login overlay handled");

      await this.scrollToLoad(page);
      console.log("[Scraper] Scroll done");

      const pageData = await this.extractPageData(page, url);
      console.log("[Scraper] Page data extracted:", pageData.title);

      const detailImages = await this.extractDetailImages(page);
      console.log("[Scraper] Detail images:", detailImages.length);

      const product = parseProductPage(pageData, url);
      product.detailImages = detailImages;

      return product;
    } finally {
      await page.close();
    }
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
   */
  async downloadImages(
    imageUrls: string[],
    concurrency: number = 3
  ): Promise<Array<{ url: string; buffer: Buffer }>> {
    const results: Array<{ url: string; buffer: Buffer }> = [];
    const uniqueUrls = [...new Set(imageUrls)];

    for (let i = 0; i < uniqueUrls.length; i += concurrency) {
      const batch = uniqueUrls.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map(async (url) => {
          const response = await fetch(sanitizeUrl(url));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());
          return { url, buffer };
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
   * Clean up browser resources.
   */
  async close(): Promise<void> {
    if (this.context) {
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

    this.browser = await chrome.launch({
      headless: this.config.headless,
      proxy: this.config.proxy as { server: string } | undefined,
    });

    this.context = await this.browser.newContext(createStealthConfig());
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
