import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright-core';

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/sortable-browser.tsx'], target: 'browser' });
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

const order = (page: Page) => page.getByTestId('order').textContent();
const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
const announcement = (page: Page) => page.locator('.pc-sortable [aria-live="polite"]').textContent();

browserTest('sortable_keyboard_reorder keeps focus on the moved item and announces its position', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    await page.getByRole('button', { name: 'Move Codex down' }).focus();
    await page.keyboard.press('Enter');
    expect(await order(page)).toBe('claude,codex,opencode,cursor');
    expect(await focusedLabel(page)).toBe('Move Codex down');
    expect(await announcement(page)).toBe('Codex moved to position 2 of 4.');
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    expect(await order(page)).toBe('claude,opencode,cursor,codex');
    // Move down no longer exists at the end, so focus moves to the item's other move control.
    expect(await focusedLabel(page)).toBe('Move Codex up');
    expect(await announcement(page)).toBe('Codex moved to position 4 of 4.');
    await page.keyboard.press('Enter');
    expect(await order(page)).toBe('claude,opencode,codex,cursor');
    expect(await focusedLabel(page)).toBe('Move Codex up');
    await page.getByRole('button', { name: 'Remove OpenCode' }).click();
    expect(await order(page)).toBe('claude,codex,cursor');
    expect(await focusedLabel(page)).toBe('Remove Codex');
    expect(await announcement(page)).toBe('OpenCode removed.');
  } finally { await page.close(); }
});

browserTest('pointer drag reorders by the handle', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    const handles = page.locator('.pc-sortable__handle');
    const from = (await handles.nth(0).boundingBox())!;
    const to = (await page.locator('.pc-sortable__item').nth(2).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, to.y + to.height * 0.75, { steps: 8 });
    await page.mouse.up();
    expect(await order(page)).toBe('claude,opencode,codex,cursor');
    expect(await announcement(page)).toBe('Codex moved to position 3 of 4.');
  } finally { await page.close(); }
});

browserTest('save bar counts changes and discard restores the saved order', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    expect(await page.getByRole('button', { name: 'Discard' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Move Claude Code up' }).click();
    expect(await page.locator('.pc-save-bar').textContent()).toContain('1 unsaved change');
    expect(await page.locator('.pc-save-bar .pc-btn--primary').count()).toBe(1);
    await page.getByRole('button', { name: 'Discard' }).click();
    expect(await order(page)).toBe('codex,claude,opencode,cursor');
    expect(await page.getByRole('button', { name: 'Discard' }).count()).toBe(0);
  } finally { await page.close(); }
});

browserTest('narrow layout keeps rows and the save bar inside the viewport', async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 720 } });
  try {
    await page.goto(server.url.href);
    await page.getByRole('button', { name: 'Move Codex down' }).click();
    for (const selector of ['.pc-sortable__item', '.pc-save-bar']) {
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
    const move = (await page.getByRole('button', { name: 'Move Codex down' }).boundingBox())!;
    expect(move.height).toBeGreaterThanOrEqual(44);
  } finally { await page.close(); }
});
