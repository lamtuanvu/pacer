import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { generateTokensCss, readTokens } from '../app/tokens-gen';
const browserPath = process.env.PACER_TEST_BROWSER;

test.skipIf(!browserPath)('skeletons delay, cancel fast loads, expose busy names, honor reduced motion and retain content', async () => {
  const build = await Bun.build({ entrypoints: ['test/fixtures/ui/skeleton.tsx'], target: 'browser' });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await page.clock.install({ time: new Date(2026, 9, 30) });
    await page.clock.pauseAt(new Date(2026, 9, 30, 0, 0, 1));
    await page.setContent('<div id="fixture"></div>');
    await page.addStyleTag({ content: generateTokensCss(readTokens('app/src/ds')) + await Bun.file('app/src/ds/components.css').text() });
    await page.addScriptTag({ content: await build.outputs[0]!.text(), type: 'module' });
    const mount = (layout: string) => page.evaluate(layout => document.dispatchEvent(new CustomEvent('skeleton:mount', { detail: layout })), layout);
    await mount('task');
    await page.clock.runFor(149);
    expect(await page.locator('[aria-busy]').count()).toBe(0);
    await page.clock.runFor(1);
    const busy = page.getByRole('status', { name: 'Loading the task' });
    expect(await busy.getAttribute('aria-busy')).toBe('true');
    expect(await busy.innerText()).toBe('');
    expect(await busy.locator('svg, button, .pc-loading__indicator').count()).toBe(0);
    expect(await busy.locator('.pc-skeleton__tile').count()).toBe(4);
    expect(await busy.locator('.pc-skeleton__trace .pc-skeleton__row').count()).toBe(4);
    expect(await busy.locator('.pc-skeleton__aside-card').count()).toBe(3);
    const block = busy.locator('.pc-skeleton__block').first();
    expect(await block.evaluate(el => getComputedStyle(el).animationDuration)).toBe('1.4s');
    expect(await block.evaluate(el => getComputedStyle(el).borderRadius)).toBe('4px');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await block.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    for (const layout of ['list', 'settings', 'dashboard', 'rows']) {
      await page.evaluate(() => document.dispatchEvent(new Event('skeleton:clear')));
      await mount(layout);
      await page.clock.runFor(150);
      expect(await busy.innerText()).toBe('');
      expect(await busy.locator('.pc-skeleton__row').count()).toBe(layout === 'dashboard' ? 8 : 4);
    }
    await page.evaluate(() => document.dispatchEvent(new Event('skeleton:clear')));
    await mount('task');
    await page.clock.runFor(100);
    await page.evaluate(() => document.dispatchEvent(new Event('skeleton:clear')));
    await page.clock.runFor(200);
    expect(await page.locator('[aria-busy]').count()).toBe(0);
    await page.evaluate(() => document.dispatchEvent(new Event('skeleton:refresh')));
    await page.clock.runFor(200);
    expect(await page.locator('#fixture').innerText()).toBe('Existing content');
    expect(await page.locator('[aria-busy]').count()).toBe(0);
  } finally { await browser.close(); }
}, 20000);
