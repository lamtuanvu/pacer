import { expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright-core';

const browserPath = process.env.PACER_TEST_BROWSER;

function plugin(overrides = {}) {
  return { id: 'checklist', version: '1.2.0', publisher: 'test', tier: 'free', bundled: false, enabled: false, state: 'disabled', contributes: [], capabilities: [], ui: { settings: 0, activity: 0, panelTabs: 0, status: 0 }, surfaces: [], grant: null, error: null, pid: null, ...overrides };
}

async function mountPlugins(page: Page, fixture: unknown) {
  let bundle: string | undefined;
  if (!bundle) {
    const result = await Bun.build({ entrypoints: ['test/fixtures/ui/settings-plugins.tsx'], target: 'browser', format: 'iife' });
    if (!result.success) throw Error(result.logs.join('\n'));
    bundle = await result.outputs[0]!.text();
  }
  const css = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/styles.css', 'app/src/screens/settings/settings.css'].map(path => Bun.file(path).text()))).join('\n');
  await page.setContent(`<style>${css}</style><div id="app"></div>`);
  await page.evaluate(data => { (window as any).fixture = data; }, fixture);
  await page.addScriptTag({ content: bundle! });
  await page.waitForFunction(() => (window as any).calls.some((c: any) => c.op === 'plugin.list'));
  await page.waitForTimeout(100);
}

test.skipIf(!browserPath)('a background refetch does not set aria-disabled on plugin switches', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await mountPlugins(page, { plugins: [plugin()], listDelay: 10000 });
    // let initial load resolve
    await page.waitForTimeout(200);
    // bump invalidation so it refetches and stays pending
    await page.evaluate(() => (window as any).invalidate());
    await page.waitForFunction(() => (window as any).calls.filter((c: any) => c.op === 'plugin.list').length >= 2);
    await page.waitForTimeout(50);
    const ariaDisabled = await page.locator('[aria-label="Enable checklist"]').getAttribute('aria-disabled');
    expect(ariaDisabled).not.toBe('true');
    expect(await page.locator('.pc-settings-plugin').count()).toBe(1);
  } finally {
    await browser.close();
  }
});

async function mountUseResource(page: Page) {
  const result = await Bun.build({ entrypoints: ['test/fixtures/ui/use-resource-browser.tsx'], target: 'browser', format: 'iife' });
  if (!result.success) throw Error(result.logs.join('\n'));
  const bundle = await result.outputs[0]!.text();
  await page.setContent(`<div id="app"></div>`);
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => (window as any).calls.some((c: any) => c.op === 'foo.get'));
}

test.skipIf(!browserPath)('useResource shows loading on first load and refreshing on later reload', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await mountUseResource(page);
    // first load pending -> loading true, refreshing false
    await page.waitForTimeout(50);
    expect(await page.locator('#status').getAttribute('data-loading')).toBe('true');
    expect(await page.locator('#status').getAttribute('data-refreshing')).toBe('false');
    // resolve first load
    await page.evaluate(() => (window as any).resolveNext({ value: 7 }));
    await page.waitForFunction(() => document.querySelector('#value')?.textContent === '7');
    // trigger a later reload that stays pending
    await page.evaluate(() => (window as any).invalidate());
    await page.waitForFunction(() => (window as any).calls.filter((c: any) => c.op === 'foo.get').length >= 2);
    await page.waitForTimeout(50);
    expect(await page.locator('#status').getAttribute('data-loading')).toBe('false');
    expect(await page.locator('#status').getAttribute('data-refreshing')).toBe('true');
    // cleanup resolve
    await page.evaluate(() => (window as any).resolveNext({ value: 7 }));
  } finally {
    await browser.close();
  }
});

async function mountKeyChange(page: Page) {
  const result = await Bun.build({ entrypoints: ['test/fixtures/ui/use-resource-key-browser.tsx'], target: 'browser', format: 'iife' });
  if (!result.success) throw Error(result.logs.join('\n'));
  await page.setContent(`<div id="app"></div>`);
  await page.addScriptTag({ content: await result.outputs[0]!.text() });
  await page.waitForFunction(() => (window as any).calls.length === 1);
}

test.skipIf(!browserPath)('useResource treats a params change as a first load instead of showing stale data', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await mountKeyChange(page);
    await page.evaluate(() => (window as any).resolveNext({ value: 1 }));
    await page.waitForFunction(() => document.querySelector('#value')?.textContent === '1');
    expect(await page.locator('#status').getAttribute('data-loading')).toBe('false');

    // Change the key while data from the previous key is loaded.
    await page.evaluate(() => (window as any).setId('b'));
    await page.waitForFunction(() => (window as any).calls.length === 2);
    expect(await page.locator('#status').getAttribute('data-hasdata')).toBe('false');
    expect(await page.locator('#status').getAttribute('data-loading')).toBe('true');
    expect(await page.locator('#status').getAttribute('data-refreshing')).toBe('false');

    await page.evaluate(() => (window as any).resolveNext({ value: 2 }));
    await page.waitForFunction(() => document.querySelector('#value')?.textContent === '2');
  } finally {
    await browser.close();
  }
});