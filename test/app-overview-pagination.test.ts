import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
const browserPath = process.env.PACER_TEST_BROWSER;

test.skipIf(!browserPath)('overview paging reaches every row, resets scope and clamps live removals', async () => {
  const build = await Bun.build({ entrypoints: ['test/fixtures/ui/overview-pagination.tsx'], target: 'browser' });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    page.on("pageerror", error => { throw error; });
    await page.setContent('<div id="fixture"></div>');
    await page.addScriptTag({ content: await build.outputs[0]!.text(), type: 'module' });
    const rows = page.locator('#rows p');
    const next = page.getByRole('button', { name: 'Next', exact: true });
    const previous = page.getByRole('button', { name: 'Previous', exact: true });
    await next.waitFor();
    expect(await rows.allTextContents()).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5']);
    await next.focus();
    await page.keyboard.press('Enter');
    await page.getByText('6–10 of 13').waitFor();
    expect(await rows.allTextContents()).toEqual(['Task 6', 'Task 7', 'Task 8', 'Task 9', 'Task 10']);
    await next.click();
    await page.getByText('11–13 of 13').waitFor();
    expect(await rows.count()).toBe(3);
    expect(await next.count()).toBe(0);
    expect(await page.locator(':focus').getAttribute('aria-label')).toBe('Tasks pages');
    await previous.click();
    await page.getByText('6–10 of 13').waitFor();
    await page.getByRole('button', { name: 'Change repository' }).click();
    await page.getByText('1–5 of 13').waitFor();
    expect(await previous.count()).toBe(0);
    await next.click();
    await page.getByRole('button', { name: 'Remove tasks' }).click();
    // Two rows fit on one page, so the range and navigation go away.
    await page.waitForFunction(() => document.querySelectorAll('#rows p').length === 2);
    expect(await rows.allTextContents()).toEqual(['Task 1', 'Task 2']);
    expect(await page.getByRole('navigation', { name: 'Tasks pages' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Restore tasks' }).click();
    await page.getByText('1–5 of 13').waitFor();
  } finally { await browser.close(); }
}, 30000);
