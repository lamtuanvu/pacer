import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
const browserPath = process.env.PACER_TEST_BROWSER;

test.skipIf(!browserPath)('the Dispatch update age counts up while nothing else re-renders', async () => {
  const build = await Bun.build({ entrypoints: ['test/fixtures/ui/dispatch-age.tsx'], target: 'browser' });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => { throw error; });
    await page.setContent('<div id="fixture"></div>');
    await page.addScriptTag({ content: await build.outputs[0]!.text(), type: 'module' });
    const age = page.locator('#age');
    await age.waitFor();
    const first = await age.textContent();
    // A frozen age would still read the same after two ticks.
    await page.waitForFunction(text => document.getElementById('age')?.textContent !== text, first, { timeout: 4000 });
    expect(await age.textContent()).not.toBe(first);
  } finally { await browser.close(); }
}, 20000);
