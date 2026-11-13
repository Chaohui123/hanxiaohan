const http = require("node:http");
const { chromium } = require("playwright");

const server = http.createServer(async (req, res) => {
  if (req.url === "/ozon-check") {
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.OZONE_BROWSER_EXECUTABLE_PATH || "/usr/bin/chromium",
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage();
      const response = await page.goto("https://seller.ozon.ru/app/analytics/what-to-sell/search-queries", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(15000);
      const result = {
        httpStatus: response.status(),
        url: page.url(),
        title: await page.title(),
        body: (await page.locator("body").innerText()).slice(0, 1200),
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
    } finally {
      if (browser) await browser.close();
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ status: "ok", service: "onzo-ozon-probe" }));
});
server.listen(Number(process.env.PORT || 8080), "0.0.0.0");
