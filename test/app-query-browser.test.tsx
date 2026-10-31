import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';

const browserPath = process.env.PACER_TEST_BROWSER;
test.skipIf(!browserPath)('mounted consumers share reads and rapid parameter changes never publish another task', async () => {
  const build = await Bun.build({ entrypoints: ['test/fixtures/app-query-browser.tsx'], target: 'browser' });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://pacer.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="app"></div>' }));
    await page.goto('http://pacer.test');
    await page.evaluate(async source => {
      await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    }, await build.outputs[0]!.text());
    const requests = () => page.evaluate(() => (window as any).queryFixture.pending.map((p: any) => p.params.id));
    await page.waitForFunction(() => (window as any).queryFixture?.pending.length === 1);
    expect(await requests()).toEqual(['one']);

    await page.evaluate(() => (window as any).queryFixture.setId('two'));
    await page.waitForFunction(() => (window as any).queryFixture.pending.length === 2);
    expect(await requests()).toEqual(['one', 'two']);
    await page.evaluate(() => (window as any).queryFixture.pending[0].resolve('OLD TASK'));
    await page.waitForTimeout(100);
    expect(await page.locator('body').innerText()).not.toContain('OLD TASK');
    await page.evaluate(() => (window as any).queryFixture.pending[1].resolve('CURRENT TASK'));
    await page.waitForFunction(() => document.querySelectorAll('[data-id="two"]').length === 2 && [...document.querySelectorAll('p')].every(p => p.textContent === 'CURRENT TASK'));

    await page.evaluate(() => (window as any).queryFixture.setCount(0));
    await page.waitForFunction(() => document.querySelectorAll('p').length === 0);
    await page.evaluate(() => (window as any).queryFixture.setCount(2));
    await page.waitForFunction(() => document.querySelectorAll('p').length === 2 && [...document.querySelectorAll('p')].every(p => p.textContent === 'CURRENT TASK'));
    expect(await requests()).toEqual(['one', 'two']);

    await page.evaluate(() => (window as any).queryFixture.setCount(0));
    await page.waitForFunction(() => document.querySelectorAll('p').length === 0);
    await page.evaluate(() => (window as any).queryFixture.setEpoch(1));
    await page.evaluate(() => (window as any).queryFixture.setCount(2));
    await page.waitForFunction(() => document.querySelectorAll('p').length === 2);
    await page.waitForTimeout(100);
    expect(await requests()).toEqual(['one', 'two', 'two']);
    await page.evaluate(() => (window as any).queryFixture.pending[2].resolve('AFTER RECONNECT'));
    await page.waitForFunction(() => [...document.querySelectorAll('p')].every(p => p.textContent === 'AFTER RECONNECT'));

    await page.evaluate(() => (window as any).queryFixture.setOwner(true));
    await page.waitForFunction(() => (window as any).queryFixture.pending.length === 4);
    expect(await page.locator('body').innerText()).not.toContain('CURRENT TASK');
    expect(await page.evaluate(() => (window as any).queryFixture.renders.some((r: any) => r.owner && r.data !== undefined))).toBe(false);
    await page.evaluate(() => (window as any).queryFixture.pending[3].resolve('NEW CLIENT'));
    await page.waitForFunction(() => [...document.querySelectorAll('p')].every(p => p.textContent === 'NEW CLIENT'));
  } finally { await browser.close(); }
});
