import { chromium } from "playwright";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(__dirname, "../packages/scraper/src/scripts/extract-page-data.js"), "utf8");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  const page = await ctx.newPage();
  await page.goto("https://detail.1688.com/offer/891784406688.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(3000);

  // Need IIFE wrapper for string-based evaluate
  const data = await page.evaluate("(" + script + ")()");
  console.log("title:", data.title);
  console.log("ogTitle:", data.ogTitle);

  // Search for price in all script tags
  const priceInfo = await page.evaluate(() => {
    const scripts = document.querySelectorAll("script");
    const results: string[] = [];
    for (const s of scripts) {
      const t = s.textContent || "";
      if (t.includes("price") || t.includes("offerPrice") || t.includes("skuPrice")) {
        results.push(t.substring(0, 200));
      }
    }
    return results;
  });
  console.log("Price-related scripts:", priceInfo.length, "found");
  for (const p of priceInfo.slice(0, 3)) console.log("  ", p.substring(0, 150));

  // Search for all data patterns
  const patterns = await page.evaluate(() => {
    const scripts = document.querySelectorAll("script");
    const found: string[] = [];
    for (const s of scripts) {
      const t = s.textContent || "";
      if (t.includes("__INITIAL_STATE__")) found.push("__INITIAL_STATE__");
      if (t.includes("__DATA__")) found.push("__DATA__");
      if (t.includes("window.__")) found.push("window.__");
      if (t.includes("offerId")) found.push("offerId-" + t.substring(t.indexOf("offerId"), t.indexOf("offerId") + 50));
    }
    return found;
  });
  console.log("Data patterns:", patterns);

  await browser.close();
  console.log("Done");
  console.log("ogImage:", data.ogImage?.substring(0, 80) || "(none)");
  console.log("images:", data.images.length, "first:", data.images[0]?.substring(0, 60) || "(none)");
  console.log("initialState:", data.initialState ? "present, keys=" + Object.keys(data.initialState).join(",") : "NULL");
  if (data.initialState?.sku) {
    console.log("sku keys:", Object.keys(data.initialState.sku).join(","));
    console.log("skuPriceRange:", JSON.stringify(data.initialState.sku.skuPriceRange));
    console.log("skuProps:", JSON.stringify(data.initialState.sku.skuProps)?.substring(0, 200));
    console.log("skuImageList:", data.initialState.sku.skuImageList?.length, "images");
  }
  await browser.close();
  console.log("Done");
}

main().catch((e) => console.error("FAIL:", e.message));
