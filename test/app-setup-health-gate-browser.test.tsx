import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright-core';

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/setup-health-gate-browser.tsx'], target: 'browser' });
  if (!built.success) throw new AggregateError(built.logs);
  const script = await built.outputs[0]!.text();
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(
    `<meta charset="utf-8"><div id="root"></div><script type="module">${script}</script>`,
    { headers: { 'Content-Type': 'text/html' } },
  ) });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 15000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 15000);

browserTest('ok setup health enters the app on its own', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}?outcome=ok`);
    await page.getByRole('heading', { level: 1, name: 'Checking setup' }).waitFor();
    await page.waitForFunction(() => document.body.dataset.ready, undefined, { timeout: 5000 });
    expect(await page.evaluate(() => document.body.dataset.ready)).toBe('ok');
    expect(await page.getByRole('heading', { name: 'Checking setup' }).count()).toBe(0);
  } finally { await page.close(); }
}, 15000);

browserTest('warnings setup health stays on the gate until the user continues', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}?outcome=warnings`);
    await page.getByRole('heading', { level: 1, name: 'Checking setup' }).waitFor();
    // A warnings outcome no longer auto-enters (only an all-passed check does):
    // the gate stays on the report until the user chooses to continue.
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => document.body.dataset.ready)).toBeUndefined();
    const proceed = page.getByRole('button', { name: 'Continue to pacer' });
    await proceed.waitFor();
    await proceed.click();
    expect(await page.evaluate(() => document.body.dataset.ready)).toBe('warnings');
    expect(await page.getByRole('heading', { name: 'Checking setup' }).count()).toBe(0);
  } finally { await page.close(); }
}, 15000);

browserTest('hard_fail setup health stays on the gate until Continue anyway', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}?outcome=hard_fail`);
    const proceed = page.getByRole('button', { name: 'Continue anyway' });
    await proceed.waitFor();
    await page.waitForTimeout(2000);
    expect(await page.evaluate(() => document.body.dataset.ready)).toBeUndefined();
    await proceed.click();
    expect(await page.evaluate(() => document.body.dataset.ready)).toBe('hard_fail');
  } finally { await page.close(); }
}, 15000);
