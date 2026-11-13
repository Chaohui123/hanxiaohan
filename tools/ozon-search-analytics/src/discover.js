import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(process.env.SELLER_CDP_URL || "http://127.0.0.1:9222");
const context = browser.contexts()[0];
if (!context) throw new Error("No existing Seller browser context");
const page = await context.newPage();
const responses = [];
page.on("response", (response) => {
  const url = response.url();
  if (/analytics|search|query|what-to-sell/i.test(url)) {
    responses.push({ status: response.status(), url, contentType: response.headers()["content-type"] || "" });
  }
});
try {
  await page.goto(process.env.SELLER_SEARCH_URL || "https://seller.ozon.ru/app/analytics/what-to-sell/search-queries", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(20000);
  console.log(JSON.stringify({
    url: page.url(),
    title: await page.title(),
    body: (await page.locator("body").innerText()).slice(0, 10000),
    responses,
  }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
