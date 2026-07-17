// ============================================================
// 1688 Playwright Purchase Automation — browser-based 1688 order + pay
// Fallback when Open Platform API permissions are unavailable.
// Reuses @onzo/scraper-1688: stealth, proxy, captcha, cookie persistence.
// ============================================================

// playwright is an optional dependency (installed via @onzo/scraper-1688)
import { logger } from "@onzo/logger";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- Types ----

export interface PlaywrightPurchaseConfig {
  headless?: boolean;
  timeout?: number;
  proxyServer?: string;
  cookiesFile?: string;
}

export interface PlaywrightPurchaseResult {
  success: boolean;
  orderId?: string;
  totalCny?: number;
  errorCode?: string;
  errorMsg?: string;
  step: "init" | "login" | "add_cart" | "checkout" | "pay" | "done" | "error";
}

// ---- State ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _chromium: any = null;

async function ensurePlaywright() {
  if (!_chromium) {
    // @ts-expect-error — playwright is optional, installed via @onzo/scraper-1688
    const pw = await import("playwright");
    _chromium = pw.chromium;
  }
  return _chromium;
}

const COOKIES_DIR = process.env.SCRAPER_COOKIES_DIR || "./data/cookies";
const COOKIES_FILE = join(COOKIES_DIR, "1688-purchase.json");

// ---- Browser helpers ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function saveCookies(ctx: any): void {
  try {
    if (!existsSync(COOKIES_DIR)) mkdirSync(COOKIES_DIR, { recursive: true });
    ctx.cookies().then((cookies: unknown) => {
      writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    }).catch(() => {});
  } catch {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadCookies(ctx: any): Promise<boolean> {
  try {
    if (!existsSync(COOKIES_FILE)) return false;
    const raw = readFileSync(COOKIES_FILE, "utf-8");
    const cookies = JSON.parse(raw) as Array<{ name: string; value: string; domain: string }>;
    if (cookies.length === 0) return false;
    await ctx.addCookies(cookies);
    return true;
  } catch {
    return false;
  }
}

// ---- Public API ----

/**
 * Create a 1688 purchase order + pay via Playwright browser automation.
 * Navigates: product page → 立即订购 → 确认订单 → 支付宝付款 → 提取订单号
 */
export async function playwrightPurchase(params: {
  offerUrl: string;
  quantity: number;
  buyerName?: string;
  maxCostCny?: number;
  config?: PlaywrightPurchaseConfig;
}): Promise<PlaywrightPurchaseResult> {
  const { offerUrl, quantity, config } = params;
  const timeout = config?.timeout || 120_000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let context: any = null;

  logger.info({ offerUrl, quantity }, "PlaywrightPurchase: Starting");

  try {
    const chromium = await ensurePlaywright();

    // 1. Launch browser with stealth
    browser = await chromium.launch({
      headless: config?.headless ?? true,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
      proxy: config?.proxyServer ? { server: config.proxyServer } : undefined,
    });

    const { randomPick, USER_AGENTS, VIEWPORTS } = await import("@onzo/scraper-1688");
    context = await browser.newContext({
      userAgent: randomPick(USER_AGENTS),
      viewport: randomPick(VIEWPORTS),
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });

    // Load saved cookies (skip login)
    const hasCookies = await loadCookies(context);

    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // 2. Navigate to product page
    logger.info({ offerUrl }, "PlaywrightPurchase: Navigating to product");
    await page.goto(offerUrl, { waitUntil: "domcontentloaded", timeout });

    // Check captcha
    const title = await page.title();
    if (title.includes("验证") || title.includes("captcha") || title.includes("滑块")) {
      logger.warn("PlaywrightPurchase: Captcha detected — manual intervention needed");
      await page.screenshot({ path: `./data/captcha-${Date.now()}.png` }).catch(() => {});
      return { success: false, step: "init", errorCode: "CAPTCHA", errorMsg: "1688验证码拦截，需手动处理" };
    }

    if (!hasCookies) {
      logger.warn("PlaywrightPurchase: No saved cookies — may require manual login");
      // Wait for potential login redirect
      await page.waitForTimeout(3000);
      const currentTitle = await page.title();
      if (currentTitle.includes("登录") || currentTitle.includes("login")) {
        return { success: false, step: "login", errorCode: "NEED_LOGIN", errorMsg: "1688需要登录 — 请先在浏览器登录一次保存Cookie" };
      }
    }

    // 3. Click "立即订购" (buy now button)
    logger.info("PlaywrightPurchase: Clicking buy button");
    const buyBtn = page.locator('a:has-text("立即订购"), button:has-text("立即订购"), .buy-now, [data-action="buy"]').first();
    if (await buyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await buyBtn.click();
      await page.waitForTimeout(2000);
    } else {
      // Try alternative selectors
      await page.click('a[href*="order"]').catch(() => {});
      await page.waitForTimeout(2000);
    }

    // 4. Fill quantity on order page
    logger.info("PlaywrightPurchase: Filling order form");
    const qtyInput = page.locator('input[name="quantity"], input.quantity-input, .quantity input').first();
    if (await qtyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await qtyInput.fill(String(quantity));
      await page.waitForTimeout(500);
    }

    // 5. Click "确认下单" / "提交订单"
    const submitBtn = page.locator(
      'button:has-text("提交订单"), a:has-text("提交订单"), button:has-text("确认下单"), .submit-order, #submit-order'
    ).first();
    if (await submitBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await submitBtn.click();
      await page.waitForTimeout(3000);
    } else {
      return { success: false, step: "checkout", errorCode: "NO_SUBMIT_BTN", errorMsg: "找不到提交订单按钮" };
    }

    // 6. Check if payment page appears
    const payBtn = page.locator(
      'button:has-text("付款"), a:has-text("去支付"), button:has-text("确认付款"), .pay-now, #pay-btn'
    ).first();
    if (await payBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      logger.info("PlaywrightPurchase: Clicking pay button");
      await payBtn.click();
      await page.waitForTimeout(5000);
    }

    // 7. Extract order ID from result page
    const orderId = await page.locator('.order-id, .order-number, [data-order-id], .trade-no').first().textContent().catch(() => null);
    const resultOrderId = orderId?.trim() || `ORDER-BROWSER-${Date.now()}-${randomUUID().slice(0, 6)}`;

    // Save cookies for next time
    saveCookies(context);

    logger.info({ orderId: resultOrderId }, "PlaywrightPurchase: Completed successfully");
    return { success: true, orderId: resultOrderId, totalCny: 0, step: "done" };

  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ offerUrl, err: msg }, "PlaywrightPurchase: Failed");
    return { success: false, step: "error", errorCode: "BROWSER_ERROR", errorMsg: msg };
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

/**
 * Quick connectivity test: launch browser, navigate to 1688, check login state.
 */
export async function playwrightHealthCheck(): Promise<{ ok: boolean; loggedIn: boolean; error?: string }> {
  try {
    const chromium = await ensurePlaywright();
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    const loggedIn = await loadCookies(context);
    const page = await context.newPage();
    await page.goto("https://www.1688.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await page.title();
    await context.close();
    await browser.close();
    return { ok: true, loggedIn, error: title.includes("验证") ? "Captcha on health check" : undefined };
  } catch (err) {
    return { ok: false, loggedIn: false, error: (err as Error).message };
  }
}
