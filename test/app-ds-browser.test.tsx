import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { renderToString } from 'preact-render-to-string';
import { Dialog } from '../app/src/ds/Dialog';
import { Disclosure } from '../app/src/ds/Controls';
import { Button } from '../app/src/ds/Button';
import { SettingsGeneral } from '../app/src/screens/settings/General';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { settings } from './fixtures/ui/settings';

// CI without an installed browser records the missing browser surface explicitly.
// Run with PACER_TEST_BROWSER pointing to a local Chromium/Chrome executable.
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);

browserTest('Dialog keyboard order includes native disclosure summaries and respects child-handled Tab', async () => {
  const build = await Bun.build({ entrypoints: ['app/src/ds/Dialog.tsx'], target: 'browser', minify: true });
  expect(build.success).toBe(true);
  const source = await build.outputs[0]!.text();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    const markup = renderToString(<Dialog title="Review evidence" close={() => {}}>
      <Disclosure summary="Technical details"><p>Evidence</p></Disclosure>
      <Button>Continue</Button>
    </Dialog>);
    await page.setContent(markup);
    await page.evaluate(async moduleSource => {
      const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));
      try {
        const { cycleDialogFocus } = await import(moduleUrl);
        const dialog = document.querySelector('dialog')!;
        dialog.addEventListener('keydown', event => cycleDialogFocus(dialog, event));
        dialog.showModal();
      } finally { URL.revokeObjectURL(moduleUrl); }
    }, source);
    const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim());
    await page.getByRole('button', { name: 'Close', exact: true }).focus();
    for (const name of ['Technical details', 'Continue', 'Close']) {
      await page.keyboard.press('Tab');
      expect(await focused()).toBe(name);
    }
    for (const name of ['Continue', 'Technical details', 'Close']) {
      await page.keyboard.press('Shift+Tab');
      expect(await focused()).toBe(name);
    }
    await page.locator('summary').focus();
    await page.locator('summary').evaluate(node => node.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key === 'Tab') event.preventDefault();
    }));
    await page.keyboard.press('Tab');
    expect(await focused()).toBe('Technical details');
  } finally { await browser.close(); }
});

browserTest('Strategies rows keep their bottom border when operation feedback follows them', async () => {
  const state = { ...initialState(), snapshot: { executors: [], accounts: [], hosts: [], repos: [] } } as any;
  const api = { call: async () => ({}), hello: async () => ({}), snapshot: async () => ({}) } as any;
  const markup = renderToString(<TaskContext.Provider value={{ state, api }}>
    <SettingsGeneral initialData={settings} />
  </TaskContext.Provider>);
  const styles = await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/screens/settings/settings.css']
    .map(path => Bun.file(path).text()));
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 700 } });
    await page.setContent(`<style>${styles.join('\n')}</style><div class="u3-general-sections">${markup}</div>`);
    const rows = page.locator('#strategies .u3-setting');
    expect(await rows.count()).toBe(2);
    const last = rows.last();
    expect(await last.evaluate(node => node.nextElementSibling?.classList.contains('u3-feedback'))).toBe(true);
    expect(await last.evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe('1px');
    expect(await last.evaluate(node => getComputedStyle(node).borderBottomStyle)).toBe('solid');
    expect(await rows.first().evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe('1px');
  } finally { await browser.close(); }
});
