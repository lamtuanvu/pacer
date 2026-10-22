import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright-core';

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/choice-picker-browser.tsx'], target: 'browser' });
  if (!built.success) throw new AggregateError(built.logs);
  const script = await built.outputs[0]!.text();
  const styles = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css'].map(path => Bun.file(path).text()))).join('\n');
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(
    `<meta charset="utf-8"><style>${styles}</style><div id="root"></div><script type="module">${script}</script>`,
    { headers: { 'Content-Type': 'text/html' } },
  ) });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 15000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 15000);

browserTest('pointer, keyboard, disabled reason, and controlled option removal', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}`);
    const trigger = page.locator('#executor');
    await trigger.click();
    expect(await trigger.getAttribute('aria-expanded')).toBe('true');
    await page.keyboard.press('ArrowDown');
    expect(await page.getByRole('listbox').getAttribute('aria-activedescendant')).toMatch(/-options-\d+$/);
    expect(await page.getByRole('option', { name: /Sign in first/ }).getAttribute('aria-disabled')).toBe('true');
    await page.getByRole('option', { name: /OpenCode/ }).click();
    expect(await trigger.textContent()).toContain('OpenCode');
    await trigger.press('Home');
    await trigger.press('Enter');
    expect(await trigger.textContent()).toContain('Codex');
    await page.locator('#remove').click();
    expect(await trigger.textContent()).toContain('Choose an executor');
  } finally { await page.close(); }
});

browserTest('search, typeahead, Escape, Tab and switching pickers', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}`);
    const first = page.locator('#executor');
    const second = page.locator('#repo');
    await first.focus();
    await first.press('o');
    await first.press('Enter');
    expect(await first.textContent()).toContain('OpenCode');
    await first.click();
    await second.click();
    expect(await first.getAttribute('aria-expanded')).toBe('false');
    await page.getByRole('searchbox').fill('Open');
    expect(await page.getByRole('option').count()).toBe(1);
    await page.getByRole('searchbox').fill('nothing matches');
    await page.getByRole('searchbox').press('Enter');
    expect(await page.getByTestId('form-status').textContent()).toBe('idle');
    await page.keyboard.press('Escape');
    expect(await second.getAttribute('aria-expanded')).toBe('false');
    expect(await second.evaluate(node => document.activeElement === node)).toBe(true);
    await second.click();
    await page.keyboard.press('Tab');
    expect(await second.getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#remove').evaluate(node => document.activeElement === node)).toBe(true);
  } finally { await page.close(); }
});

browserTest('narrow popup stays onscreen and native dialog contains its menu', async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 720 } });
  try {
    await page.goto(`${server.url}`);
    await page.locator('#executor').click();
    const menu = page.getByRole('listbox');
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    await page.keyboard.press('Escape');
    await page.locator('#open-modal').click();
    await page.locator('#dialog-choice').click();
    expect(await page.locator('dialog').getByRole('option').count()).toBe(4);
    await page.keyboard.press('Escape');
    expect(await page.locator('dialog').getAttribute('open')).not.toBeNull();
    expect(await page.locator('#dialog-choice').getAttribute('aria-expanded')).toBe('false');
  } finally { await page.close(); }
});

browserTest('long list keeps keyboard-active options visible and popup fits near the bottom', async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 500 } });
  try {
    await page.goto(`${server.url}`);
    await page.locator('#long-list').click();
    await page.keyboard.press('End');
    const visible = await page.getByRole('listbox').evaluate(box => {
      const active = document.getElementById(box.getAttribute('aria-activedescendant')!);
      return !!active && active.getBoundingClientRect().bottom <= box.getBoundingClientRect().bottom;
    });
    expect(visible).toBe(true);
    await page.keyboard.press('Escape');
    await page.locator('#bottom-choice').click();
    const bounds = await page.locator('.pc-choice-picker__popover').boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(500);
  } finally { await page.close(); }
});

browserTest('Tab from a dialog picker continues to the next dialog control', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}`);
    await page.locator('#open-modal').click();
    await page.locator('#dialog-choice').click();
    await page.keyboard.press('Tab');
    expect(await page.locator('#after-dialog-choice').evaluate(node => document.activeElement === node)).toBe(true);
  } finally { await page.close(); }
});
