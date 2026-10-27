import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);
async function open(fn: (page: import('playwright-core').Page) => Promise<void>) {
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/add-host.tsx'], target: 'browser', minify: true });
  expect(built.success).toBe(true);
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="app"></div>');
    await page.addScriptTag({ content: await built.outputs[0]!.text() });
    await fn(page);
  } finally { await browser.close(); }
}
const calls = (page: import('playwright-core').Page) => page.evaluate(() => (window as any).hostFixture.calls() as [string, any][]);

browserTest('Add remote host: pick an alias, name it, then watch a live connect-and-check', async () => {
  await open(async page => {
    const connect = page.getByRole('button', { name: 'Connect and check', exact: true });
    expect(await connect.isDisabled()).toBe(true);
    expect(await page.getByText('Pick a host from your SSH config first.').count()).toBe(1);
    await page.getByRole('button', { name: 'devbox', exact: true }).click();
    // The name is suggested from the alias and can be edited; a taken name blocks the check with a reason.
    const name = page.getByRole('textbox', { name: /Name it in pacer/ });
    expect(await name.inputValue()).toBe('devbox');
    await name.fill('taken');
    expect(await connect.isDisabled()).toBe(true);
    await page.getByText('Another host already has this name.').waitFor();
    await name.fill('Bad Name');
    expect(await connect.isDisabled()).toBe(true);
    await name.fill('dev-1');
    await connect.click();
    await page.getByRole('status').filter({ hasText: 'dev-1 is connected' }).waitFor();
    expect((await calls(page)).map(([op]) => op).filter(op => op === 'host.add' || op === 'host.check')).toEqual(['host.add', 'host.check']);
    expect((await calls(page)).find(([op]) => op === 'host.add')![1]).toEqual({ alias: 'dev-1', ssh: 'devbox' });
    const list = page.getByRole('list', { name: 'Checks for dev-1' });
    expect(await list.getByRole('listitem').allTextContents()).toEqual(['✓Passed: Connects with your SSH key, no password prompt', '✓Passed: git 2.30 or newer2.47.0']);
    expect(await page.getByRole('link', { name: 'Map repositories' }).getAttribute('href')).toBe('#/settings/hosts/dev-1');
    expect(await connect.count()).toBe(0);
  });
}, 20000);

browserTest('a failed check names the reason and checks again without adding the host twice', async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).hostFixture.failFirst(true));
    await page.getByRole('button', { name: 'pi-lab', exact: true }).click();
    await page.getByRole('button', { name: 'Connect and check', exact: true }).click();
    await page.getByRole('button', { name: 'Check again', exact: true }).waitFor();
    expect(await page.getByRole('list', { name: 'Checks for pi-lab' }).textContent()).toContain('Failed: Connects with your SSH key');
    expect(await page.getByRole('link', { name: 'Map repositories' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Check again', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'pi-lab is connected' }).waitFor();
    expect((await calls(page)).filter(([op]) => op === 'host.add')).toHaveLength(1);
  });
}, 20000);

browserTest('Stepper moves focus with the arrow keys, Home and End, and selects with Enter', async () => {
  await open(async page => {
    const buttons = page.getByRole('list', { name: 'Wizard' }).getByRole('button');
    expect(await buttons.count()).toBe(3);
    await buttons.nth(0).focus();
    await page.keyboard.press('ArrowDown');
    expect(await buttons.nth(1).evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('End');
    expect(await buttons.nth(2).evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(await buttons.nth(2).evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.locator('#picked').textContent()).toBe('2');
    expect(await page.locator('[aria-current="step"]').count()).toBe(1);
    expect(await page.getByText('D', { exact: true }).evaluate(n => n.closest('button'))).toBeNull();
  });
}, 20000);
