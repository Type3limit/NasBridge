import { loadPlaywrightChromium, launchPlaywrightBrowser } from "../storage-client/src/bot/tools/playwright.js";

async function inspect(url) {
  const chromium = await loadPlaywrightChromium();
  const browser = await launchPlaywrightBrowser({ chromium, scope: "BOT_WEB_PLAYWRIGHT", headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN"
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000);
    const info = await page.evaluate(() => {
      const selectors = [
        "li.b_algo h2 a",
        ".b_algo a",
        "a.result__a",
        "article a",
        "main a"
      ];
      const selectorCounts = Object.fromEntries(selectors.map((selector) => [selector, document.querySelectorAll(selector).length]));
      const samples = [...document.querySelectorAll("a[href]")]
        .slice(0, 20)
        .map((anchor) => ({
          text: String(anchor.textContent || "").replace(/\s+/g, " ").trim(),
          href: String(anchor.getAttribute("href") || "").trim(),
          className: String(anchor.className || "").trim(),
          outerHTML: String(anchor.outerHTML || "").slice(0, 280)
        }))
        .filter((item) => item.text || item.href);
      return {
        title: document.title,
        url: location.href,
        selectorCounts,
        bodyText: String(document.body?.innerText || "").slice(0, 1200),
        samples
      };
    });
    console.log(JSON.stringify(info, null, 2));
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
}

const url = process.argv[2];
if (!url) {
  throw new Error("url is required");
}
await inspect(url);
