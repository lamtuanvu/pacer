import { expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright-core';
import { renderToString } from 'preact-render-to-string';
import { SettingRow } from '../app/src/ds/SettingRow';
import { TextInput } from '../app/src/ds/Controls';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browserPath = process.env.PACER_TEST_BROWSER;
const plugin = (overrides = {}) => ({ id: 'checklist', version: '1.2.0', publisher: 'test', tier: 'free', bundled: false, enabled: false, state: 'disabled', contributes: [], capabilities: [], ui: { settings: 0, activity: 0, panelTabs: 0, status: 0 }, surfaces: [], grant: null, error: null, pid: null, ...overrides });
const css = async () => (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/styles.css', 'app/src/screens/settings/settings.css'].map(path => Bun.file(path).text()))).join('\n');
let bundle: string;
async function mount(page: Page, fixture: unknown) {
  if (!bundle) {
    const result = await Bun.build({ entrypoints: ['test/fixtures/ui/settings-plugins.tsx'], target: 'browser', format: 'iife' });
    if (!result.success) throw Error(result.logs.join('\n'));
    bundle = await result.outputs[0]!.text();
  }
  await page.setContent(`<style>${await css()}</style><div id="app"></div>`);
  await page.evaluate(data => { (window as any).fixture = data; }, fixture);
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => (window as any).calls.some((c: any) => c.op === 'plugin.list'));
  await page.waitForTimeout(100);
}
const mutations = (page: Page) => page.evaluate(() => (window as any).calls.filter((c: any) => c.op !== 'plugin.list'));

test('SettingRow h3 preserves canonical label association and default semantics', () => {
  const html = renderToString(<SettingRow headingLevel={3} variant="budget" label="Reserve"><TextInput id="reserve" /></SettingRow>);
  expect(html).toMatch(/<h3[^>]*><label[^>]*for="reserve"[^>]*>Reserve<\/label><\/h3>/);
  expect(renderToString(<SettingRow label="Ordinary"><TextInput /></SettingRow>)).not.toContain('<h3');
});

test.skipIf(!browserPath)('Plugins loads empty state and hides an unavailable operation', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await mount(page, { plugins: [] });
    expect(await page.getByText('No plugins installed.', { exact: true }).count()).toBe(1);
    expect(await page.locator('.pc-settings-plugin').count()).toBe(0);
    expect(await page.getByRole('link', {name:'Manage in Plugins'}).getAttribute('href')).toBe('#/settings/plugins');
    await mount(page, { plugins: [], failList: true });
    expect(await page.locator('section').count()).toBe(0);
  } finally { await browser.close(); }
});

test.skipIf(!browserPath)('Plugins renders real rows and reloads after enable and disable', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await mount(page, { plugins: [plugin({ bundled: true, ui: { settings: 1, activity: 1, panelTabs: 0, status: 0 }, contributes: ['ui', 'decision'] }), plugin({ id: 'empty' })] });
    expect(await page.getByText('Adds a settings page, an activity-bar view, routing engines.', { exact: true }).count()).toBe(1);
    expect(await page.getByText('Built in', { exact: true }).count()).toBe(1);
    expect(await page.getByText('1.2.0 · by test', { exact: true }).count()).toBe(2);
    expect(await page.locator('.pc-settings-plugin').nth(1).locator('.pc-settings-board__caption').count()).toBe(1);
    const control = page.getByRole('switch', { name: 'Enable checklist', exact: true });
    expect(await page.getByRole('list', { name: 'Plugins', exact: true }).locator(':scope > li').count()).toBe(2);
    await control.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Enable checklist"]')?.getAttribute('aria-checked') === 'true');
    await control.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Enable checklist"]')?.getAttribute('aria-checked') === 'false');
    expect(await mutations(page)).toEqual([{ op: 'plugin.enable', params: { id: 'checklist' } }, { op: 'plugin.disable', params: { id: 'checklist' } }]);
    expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.op === 'plugin.list').length)).toBe(3);
  } finally { await browser.close(); }
});

test.skipIf(!browserPath)('Plugins keeps keyboard focus through mutations and delayed reloads', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await mount(page, { plugins: [plugin()], actionDelay: 250, listDelay: 200, delayedInvalidation: true });
    const control = page.getByRole('switch', { name: 'Enable checklist', exact: true });
    await control.focus();
    await control.evaluate(node => {
      (window as any).originalSwitch = node;
      (window as any).switchBlurs = 0;
      node.addEventListener('blur', () => (window as any).switchBlurs++);
    });
    for (const [enabled, settled] of [[true, 3], [false, 5]] as const) {
      await page.keyboard.press('Space');
      await page.waitForFunction(() => {
        const control = document.querySelector<HTMLInputElement>('[role="switch"]');
        return control?.disabled || control?.getAttribute('aria-disabled') === 'true';
      });
      expect(await control.evaluate(node => (node as HTMLInputElement).disabled)).toBe(false);
      expect(await control.evaluate(node => document.activeElement === node)).toBe(true);
      // Repeated input during the pending operation must not dispatch another change.
      await page.keyboard.press('Space');
      await page.waitForTimeout(1600);
      await page.waitForFunction(count => (window as any).listsSettled >= count, settled);
      expect(await control.isChecked()).toBe(enabled);
      expect(await control.getAttribute('aria-checked')).toBe(String(enabled));
      expect(await control.evaluate(node => node === (window as any).originalSwitch && document.activeElement === node)).toBe(true);
      expect(await page.evaluate(() => (window as any).switchBlurs)).toBe(0);
    }
    expect(await mutations(page)).toEqual([{ op: 'plugin.enable', params: { id: 'checklist' } }, { op: 'plugin.disable', params: { id: 'checklist' } }]);
  } finally { await browser.close(); }
});

test.skipIf(!browserPath)('Plugins keeps loaded rows and inline errors when a reload fails', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await mount(page, { plugins: [plugin()], failAction: true, failReload: true });
    const control = page.getByRole('switch', { name: 'Enable checklist', exact: true });
    await control.click();
    await page.getByText('Could not load plugins', { exact: true }).waitFor();
    expect(await page.getByText('Could not change plugin', { exact: true }).count()).toBe(1);
    expect(await page.getByRole('list', { name: 'Plugins', exact: true }).locator(':scope > li').count()).toBe(1);
    expect(await control.isChecked()).toBe(false);
    expect(await control.evaluate(node => document.activeElement === node)).toBe(true);
  } finally { await browser.close(); }
});

test.skipIf(!browserPath)('Plugins describes permanently refused switches', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await mount(page, { plugins: [plugin({ state: 'refused', error: 'Unsupported plugin protocol' })] });
    const control = page.getByRole('switch', { name: 'Enable checklist', exact: true });
    expect(await control.isDisabled()).toBe(true);
    expect(await control.evaluate(node => document.getElementById(node.getAttribute('aria-describedby')!)?.textContent)).toBe('Unsupported plugin protocol');
    expect(await mutations(page)).toEqual([]);
  } finally { await browser.close(); }
});

test.skipIf(!browserPath)('Plugins grants only after confirmation and reports operation errors inline', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await mount(page, { plugins: [plugin()], needsGrant: true });
    await page.getByRole('switch', { name: 'Enable checklist' }).focus();
    await page.keyboard.press('Space');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain('config.read');
    expect(await dialog.textContent()).toContain('settings pages');
    expect(await mutations(page)).toEqual([{ op: 'plugin.enable', params: { id: 'checklist' } }]);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Enable checklist');
    expect(await mutations(page)).toHaveLength(1);
    expect(await page.getByRole('switch').isChecked()).toBe(false);
    await page.getByRole('switch').click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Grant and enable', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true');
    expect(await mutations(page)).toEqual([{ op: 'plugin.enable', params: { id: 'checklist' } }, { op: 'plugin.enable', params: { id: 'checklist' } }, { op: 'plugin.enable', params: { id: 'checklist', grant: true } }]);
    await mount(page, { plugins: [plugin()], failAction: true });
    await page.getByRole('switch').click();
    await page.getByText('Could not change plugin', { exact: true }).waitFor();
    expect(await page.getByRole('switch').isChecked()).toBe(false);
  } finally { await browser.close(); }
});

test.skipIf(!browserPath)('Plugins board geometry and narrow containment in both themes', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const screenshots = await mkdtemp(join(tmpdir(), 'settings-plugins-'));
    for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await mount(page, { plugins: [plugin({ bundled: true, ui: { settings: 1, activity: 1, panelTabs: 1, status: 0 } })] });
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      expect(await page.locator('.pc-settings-plugin').evaluate(node => {
        const s = getComputedStyle(node), tile = getComputedStyle(node.querySelector('.pc-settings-plugin__icon')!);
        return { gap: s.gap, padding: s.padding, tile: [tile.width, tile.height, tile.borderRadius], radius: getComputedStyle(node.parentElement!).borderRadius };
      })).toEqual({ gap: '12px', padding: '12px 16px', tile: ['32px', '32px', '8px'], radius: '10px' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: join(screenshots, `${theme}-${width}.png`), fullPage: true });
      await page.close();
    }
  } finally { await browser.close(); }
});
