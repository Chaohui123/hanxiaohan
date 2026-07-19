import { chromium } from "playwright";

async function main() {
  console.log("1. Launching browser...");
  const browser = await chromium.launch({ headless: true });
  console.log("2. Browser launched");
  const page = await browser.newPage();
  console.log("3. Page created, navigating...");
  await page.goto("https://www.baidu.com", { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("4. Title:", await page.title());
  await browser.close();
  console.log("5. Done!");
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
