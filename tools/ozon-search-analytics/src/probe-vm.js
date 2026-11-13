const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto("https://seller.ozon.ru/app/analytics/what-to-sell/search-queries", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForTimeout(20000);
  console.log(JSON.stringify({
    url: page.url(),
    title: await page.title(),
    body: (await page.locator("body").innerText()).slice(0, 1500),
  }));
  await browser.close();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
