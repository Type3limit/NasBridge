import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const base = process.argv[2] || 'https://nasbridge.online';
const out = process.env.UI_TEST_OUTPUT || 'local/ui-live';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.UI_TEST_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
const results = [], errors = [], badAssets = [], headers = {};
async function measure(context, label) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push({ label, message: error.message }));
  page.on('response', response => {
    if (!response.url().includes('/assets/')) return;
    if (response.status() >= 400) badAssets.push({ url: response.url(), status: response.status() });
    headers[new URL(response.url()).pathname] = { encoding: response.headers()['content-encoding'], cache: response.headers()['cache-control'] };
  });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByPlaceholder('name@example.com').waitFor({ timeout: 60000 });
  const formReadyMs = await page.evaluate(() => performance.now());
  await page.locator('.accessArtwork').evaluate(img => img.decode());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const assets = performance.getEntriesByType('resource').filter(item => item.name.includes('/assets/'));
    return { artworkReadyMs: performance.now(), ttfbMs: nav.responseStart, protocol: nav.nextHopProtocol,
      firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
      assetBytes: assets.reduce((sum, item) => sum + item.encodedBodySize, 0),
      transferredBytes: assets.reduce((sum, item) => sum + item.transferSize, 0),
      assets: assets.map(item => ({ url: item.name, duration: item.duration, transferSize: item.transferSize })) };
  });
  assert(!metrics.assets.some(item => /hls-player|AiStarMap|ChatRoom|PreviewModal/.test(item.url)), 'Heavy optional modules loaded during login');
  await page.getByPlaceholder('name@example.com').fill('ui-check@example.invalid');
  assert.equal(await page.getByPlaceholder('name@example.com').inputValue(), 'ui-check@example.invalid');
  results.push({ label, formReadyMs, ...metrics });
  console.log(JSON.stringify({ label, formReadyMs, ...metrics, assets: undefined }));
  return page;
}
try {
  for (let i = 1; i <= 3; i++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await measure(context, `cold-${i}`);
    if (i === 3) await measure(context, 'warm');
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const throttled = await context.newPage();
  const cdp = await context.newCDPSession(throttled);
  await cdp.send('Network.enable');
  // Throttle applies to the browser target created here; measure uses this page via a tiny context adapter.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 250000, uploadThroughput: 125000 });
  const page = await measure({ newPage: async () => throttled }, '2Mbps-80ms');
  await page.screenshot({ path: `${out}/dark-login.png` });
  await page.getByRole('button', { name: '切换浅色主题', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('name@example.com').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.locator('.accessArtwork').evaluate(img => img.decode());
  await page.screenshot({ path: `${out}/light-login.png` });
  for (const path of ['/share.html', '/living-room.html']) {
    await page.goto(base + path, { waitUntil: 'domcontentloaded' });
    await page.locator('#root > *').first().waitFor();
    assert((await page.locator('#root').innerText()).trim().length > 10);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  }
  const other = await context.newPage();
  await other.goto(base, { waitUntil: 'domcontentloaded' });
  await other.getByRole('button', { name: '切换深色主题', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await other.emulateMedia({ reducedMotion: 'reduce' });
  const animation = await other.locator('.accessArtwork').evaluate(img => getComputedStyle(img).animationName);
  assert.equal(animation, 'none');
  await other.emulateMedia({ reducedMotion: 'no-preference' });
  assert.notEqual(await other.locator('.accessArtwork').evaluate(img => getComputedStyle(img).animationName), 'none');
  assert.deepEqual(errors, []);
  assert.deepEqual(badAssets, []);
  fs.writeFileSync(`${out}/results.json`, JSON.stringify({ base, measuredAt: new Date().toISOString(), results, errors, badAssets, headers,
    checks: ['login inputs usable', 'optional media/3D modules deferred', 'all three entry pages render', 'theme persists across entry pages and reload', 'theme syncs between tabs', 'reduced motion honored'] }, null, 2));
  await context.close();
  console.log('PASS: startup, artwork loading, all entries, theme persistence and motion preferences');
} finally { await browser.close(); }
