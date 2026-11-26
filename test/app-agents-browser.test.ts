import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright-core';

// Dispatcher › Agents in a real browser: the page draft (models + limits), the immediate Takes work write,
// the Add a model combobox, removal focus and the leave guard. Carries over the Executors and Model matrix
// browser coverage.
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser, script = '', styles = '';
beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/agents-editor.tsx'], target: 'browser', minify: true });
  if (!built.success) throw new AggregateError(built.logs);
  script = await built.outputs[0]!.text();
  styles = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/ds/feedback.css', 'app/src/styles.css', 'app/src/screens/settings/settings.css'].map(path => Bun.file(path).text()))).join('\n');
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 20000);
afterAll(async () => { await browser?.close(); }, 20000);
async function open(fn: (page: Page) => Promise<void>, viewport = { width: 1440, height: 1000 }, hash = '') {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(3000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent(`<style>${styles}</style><div id="app"></div>`);
    if (hash) await page.evaluate(value => { location.hash = value; }, hash);
    await page.addScriptTag({ content: script });
    await page.getByRole('navigation', { name: 'Agents' }).waitFor();
    await fn(page);
    expect(errors).toEqual([]);
  } finally {
    // A dirty draft registers beforeunload; close without running it so the browser can shut down.
    await page.close({ runBeforeUnload: false });
  }
}
const fixture = <T>(page: Page, call: string) => page.evaluate(name => (window as any).agentsFixture[name](), call) as Promise<T>;
/** Choose an agent in the list; in page (this fixture has no shell panel) focus then moves to its heading. */
const pick = async (page: Page, name: string) => {
  await page.getByRole('navigation', { name: 'Agents' }).getByRole('link', { name: new RegExp(`^${name}(?! ·)`) }).click();
  await page.waitForFunction(label => document.activeElement?.id === 'agent-detail-title' && !!document.activeElement.textContent?.includes(label), name);
};

browserTest('the list selects one agent at a time with aria-current; the planner comes first', async () => {
  await open(async page => {
    const links = page.getByRole('navigation', { name: 'Agents' }).getByRole('link');
    const names = (await links.allInnerTexts()).map(text => text.split('\n')[0]!.trim());
    expect(names).toEqual(['Add agent', 'Claude Code', 'Codex', expect.stringContaining('tse'), 'Claude Code · spare']);
    expect(await page.locator('[aria-current="page"]').count()).toBe(1);
    expect(await page.getByRole('heading', { level: 2 }).first().innerText()).toContain('Claude Code');
    await page.getByText('Take complex tasks when no executor can').waitFor();
    await pick(page, 'Codex');
    await page.getByRole('heading', { level: 2, name: /Codex/ }).waitFor();
    expect(await page.locator('[aria-current="page"]').getAttribute('href')).toBe('#/settings/agents?agent=codex');
    expect(await page.getByText('Take complex tasks when no executor can').count()).toBe(0);
  });
}, 20000);

browserTest('Tasks at once and priority stay in one draft across agents and save once; the save bar is hidden while idle', async () => {
  await open(async page => {
    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    expect(await bar.count()).toBe(0);
    await pick(page, 'Codex');
    const tasks = page.getByRole('spinbutton', { name: 'Tasks at once', exact: true });
    await tasks.fill('0');
    await page.getByText('Enter a whole number from 1 to 16.', { exact: true }).first().waitFor();
    const save = page.getByRole('button', { name: 'Save changes', exact: true });
    expect(await save.isDisabled()).toBe(true);
    await tasks.fill('2');
    expect(await bar.count()).toBe(1);
    // Choosing another agent keeps the draft (no leave prompt).
    await pick(page, 'tse');
    expect(await page.getByRole('dialog').count()).toBe(0);
    const priority = page.getByRole('spinbutton', { name: 'Priority', exact: true });
    await priority.fill('1');
    // Wait for the summary to update instead of reading it once (it renders after the edit).
    await page.locator('.pc-save-bar').filter({ hasText: 'Codex runs 2 at once' }).filter({ hasText: 'Priority order changed' }).waitFor();
    expect(await fixture<number>(page, 'writes')).toBe(0);
    await save.click();
    await page.getByRole('status').filter({ hasText: 'Agent settings saved' }).waitFor();
    expect(await fixture<number>(page, 'writes')).toBe(1);
    expect(await fixture<any>(page, 'settings')).toMatchObject({ order: ['opencode#tse', 'codex'], runners: [{ id: 'opencode#tse', maxTasks: 1 }, { id: 'codex', maxTasks: 2 }] });
    await page.waitForFunction(() => !document.querySelector('[role="region"][aria-label="Unsaved changes"]'));
  });
}, 20000);

browserTest('a draft kept through an external change shows the conflict, keeps its values and Discard reloads', async () => {
  await open(async page => {
    await pick(page, 'Codex');
    const tasks = page.getByRole('spinbutton', { name: 'Tasks at once', exact: true });
    await tasks.fill('3');
    await fixture(page, 'external');
    await page.getByText('Settings changed elsewhere', { exact: true }).waitFor();
    expect(await tasks.inputValue()).toBe('3');
    expect(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#agent-tasks-at-once') as HTMLInputElement)?.value === '1');
  });
}, 20000);

browserTest('Takes work saves immediately, stays busy, keeps page edits and reverts on failure', async () => {
  await open(async page => {
    await pick(page, 'Codex');
    const tasks = page.getByRole('spinbutton', { name: 'Tasks at once', exact: true });
    await tasks.fill('4');
    const toggle = page.getByRole('switch', { name: 'Codex takes work', exact: true });
    expect(await toggle.isChecked()).toBe(true);
    await fixture(page, 'holdSave');
    await toggle.click();
    await page.waitForFunction(() => [...document.querySelectorAll('.pc-immediate-save__control')].some(el => el.getAttribute('aria-busy') === 'true'));
    expect(await toggle.isDisabled()).toBe(true);
    // S1: Save waits for Takes work, with its reason shown.
    expect(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled()).toBe(true);
    await page.getByText('Wait until Takes work has saved.').waitFor();
    await fixture(page, 'release');
    await page.waitForFunction(() => [...document.querySelectorAll('.pc-immediate-save__control')].every(el => el.getAttribute('aria-busy') === 'false'));
    expect(await toggle.isChecked()).toBe(false);
    expect(await tasks.inputValue()).toBe('4');
    expect(await fixture<any>(page, 'settings')).toMatchObject({ runners: [{ id: 'codex', enabled: false, maxTasks: 1 }, { id: 'opencode#tse', enabled: true, maxTasks: 1 }] });
    await page.evaluate(() => (window as any).agentsFixture.fail(true));
    await toggle.click();
    await page.getByRole('alert').filter({ hasText: /Couldn.t save/ }).waitFor();
    expect(await toggle.isChecked()).toBe(false);
  });
}, 20000);

browserTest('Add a model: type, arrow and Enter add the listed model at its suggested size; Save writes set_many once', async () => {
  await open(async page => {
    await pick(page, 'tse');
    const box = page.getByRole('combobox', { name: 'Add a model' });
    await box.focus();
    expect(await box.getAttribute('aria-expanded')).toBe('true');
    await box.pressSequentially('pro');
    await page.keyboard.press('ArrowDown');
    const active = await box.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(await page.locator(`[id="${active}"]`).innerText()).toContain('terastor-ai-pro');
    await page.keyboard.press('Enter');
    await page.getByText('Added, not saved', { exact: true }).waitFor();
    expect(await box.inputValue()).toBe('');
    expect(await box.evaluate(el => el === document.activeElement)).toBe(true);
    expect(await page.getByRole('group', { name: 'Size of terastor-ai-pro' }).getByRole('button', { name: 'Frontier' }).getAttribute('aria-pressed')).toBe('true');
    // Escape closes the list first, then clears typed text, and never leaves Settings.
    await box.pressSequentially('x');
    await page.keyboard.press('Escape');
    expect(await box.getAttribute('aria-expanded')).toBe('false');
    await page.keyboard.press('Escape');
    expect(await box.inputValue()).toBe('');
    expect(await fixture<number>(page, 'shellEscapes')).toBe(0);
    // Freeing the planner: an executor with a frontier model now takes complex tasks.
    await page.getByText('These changes free the planner').waitFor();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Agent settings saved' }).waitFor();
    expect(await fixture<number>(page, 'modelWrites')).toBe(1);
    expect((await fixture<any>(page, 'models'))['opencode#tse'].models).toEqual([{ id: 'terastor-ai', tier: 'medium' }, { id: 'terastor-ai-pro', tier: 'frontier' }]);
    expect(await page.getByText('Added, not saved', { exact: true }).count()).toBe(0);
  });
}, 20000);

browserTest('any typed id can be added; a size change and a default change join the same save', async () => {
  await open(async page => {
    await pick(page, 'Codex');
    const box = page.getByRole('combobox', { name: 'Add models' });
    await box.fill('gpt-5-codex');
    await page.getByRole('option', { name: /Add gpt-5-codex \(not listed\)/ }).click();
    await page.getByRole('group', { name: 'Size of gpt-5-codex' }).getByRole('button', { name: 'Medium' }).click();
    await page.getByRole('combobox', { name: 'Add a model' }).fill('gpt-5-mini');
    await page.keyboard.press('Enter');
    await page.getByText('Make default: gpt-5-mini').click();
    const summary = await page.locator('.pc-save-bar').innerText();
    for (const line of ['gpt-5-codex added at medium', 'gpt-5-mini added, unrated', 'gpt-5-mini made default']) expect(summary).toContain(line);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Agent settings saved' }).waitFor();
    expect((await fixture<any>(page, 'models')).codex).toMatchObject({ default: 'gpt-5-mini', models: [{ id: 'gpt-5-codex', tier: 'medium' }, { id: 'gpt-5-mini', tier: 'unknown' }] });
  });
}, 20000);

browserTest('leaving with a draft asks first; Stay keeps it', async () => {
  await open(async page => {
    await pick(page, 'Codex');
    const tasks = page.getByRole('spinbutton', { name: 'Tasks at once', exact: true });
    await tasks.fill('5');
    await page.evaluate(() => { void (window as any).agentsFixture.leave('#/settings/planner'); });
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Stay', exact: true }).click();
    expect(await tasks.inputValue()).toBe('5');
    expect(await page.evaluate(() => (window as any).agentsFixture.leave('#/settings/agents?agent=codex'))).toBe(true);
  });
}, 20000);

browserTest('Remove asks first and then focuses Add agent; a failed check card names the reason once', async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).agentsFixture.failing(true));
    await pick(page, 'Codex');
    const card = page.locator('.pc-card--bad');
    await card.waitFor();
    expect(await page.locator('.pc-agent-detail__head [role="tooltip"]').textContent()).toContain('Endpoint returned 402');
    // The header names the agent; the reason is stated once, in its card.
    expect(await page.locator('.pc-agent-detail__head .pc-agent-card__caption').first().innerText()).toBe('codex');
    await page.getByRole('button', { name: /^Remove Codex/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.textContent?.includes('Add agent'));
    expect(await fixture<any>(page, 'settings')).toMatchObject({ order: ['opencode#tse'] });
  });
}, 20000);

for (const width of [1440, 768, 375]) browserTest(`the Agents tab stays inside the page at ${width}px`, async () => {
  await open(async page => {
    await pick(page, 'tse');
    await page.getByRole('combobox', { name: 'Add a model' }).focus();
    // Nothing sticks out of the page except inside its own scroller (the models table).
    const wide = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body *')].filter(el => !el.closest('.pc-agent-models') && el.getBoundingClientRect().right > innerWidth + 1).map(el => `${el.tagName}.${el.className}`));
    expect(wide).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Every control on the page keeps an accessible name.
    // Only controls a person can reach: hidden ones (inside a closed disclosure, say) are not checked.
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, input, a')].filter(el => (el as HTMLElement).checkVisibility({ visibilityProperty: true }) && !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el as HTMLElement).innerText.trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label'))).map(el => el.outerHTML.slice(0, 120)));
    expect(unnamed).toEqual([]);
  }, { width, height: 1000 });
}, 20000);

browserTest('with nothing pending the save bar is visually hidden, and shows again for a change', async () => {
  await open(async page => {
    const bar = page.locator('.pc-save-bar');
    expect(await bar.getAttribute('class')).toContain('pc-save-bar--clean');
    expect(await page.getByRole('region', { name: 'Save status' }).count()).toBe(0);
    await pick(page, 'Codex');
    await page.getByRole('spinbutton', { name: 'Tasks at once', exact: true }).fill('3');
    await page.getByRole('region', { name: 'Unsaved changes' }).waitFor();
    expect(await bar.getAttribute('class')).not.toContain('pc-save-bar--clean');
  });
}, 20000);

browserTest('the planner fallback card keeps its switch beside the text, not under a tall empty block', async () => {
  await open(async page => {
    const card = page.locator('.pc-agent-fallback');
    await card.waitFor();
    const box = (await card.boundingBox())!, text = (await card.locator('.pc-agent-fallback__text').boundingBox())!;
    expect(box.height).toBeLessThan(text.height + 80);
    const toggle = (await card.getByRole('switch').boundingBox())!;
    expect(toggle.y).toBeLessThan(text.y + text.height);
  });
}, 20000);

browserTest('B1: the planner fallback switch does not block a pending limits save', async () => {
  await open(async page => {
    await pick(page, 'Codex');
    await page.getByRole('spinbutton', { name: 'Tasks at once', exact: true }).fill('3');
    await pick(page, 'Claude Code');
    await page.getByRole('switch', { name: 'Take complex tasks when no executor can' }).click();
    await page.waitForFunction(() => (window as any).agentsFixture.calls().some(([op]: [string]) => op === 'config.set'));
    await page.waitForTimeout(100);
    expect(await page.getByText('Settings changed elsewhere', { exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Agent settings saved' }).waitFor();
    expect(await fixture<any>(page, 'settings')).toMatchObject({ runners: [{ id: 'codex', maxTasks: 3 }, { id: 'opencode#tse', maxTasks: 1 }] });
  });
}, 20000);

browserTest('B2/UI-2: Enter adds what was typed; an id already on the agent is shown as Already added and not re-added', async () => {
  await open(async page => {
    await pick(page, 'tse');
    const box = page.getByRole('combobox', { name: 'Add a model' });
    await box.fill('terastor-ai');
    await page.getByRole('option', { name: /^terastor-ai .*Already added/ }).waitFor();
    await page.keyboard.press('Enter');
    await page.getByRole('status').filter({ hasText: 'terastor-ai: Already added' }).waitFor();
    expect(await page.getByText('Added, not saved', { exact: true }).count()).toBe(0);
    // A prefix of a listed id adds the typed id, not the longer listed one.
    await box.fill('terastor');
    await page.keyboard.press('Enter');
    await page.getByRole('group', { name: 'Size of terastor', exact: true }).waitFor();
    expect(await page.getByRole('group', { name: 'Size of terastor-ai-pro', exact: true }).count()).toBe(0);
  });
}, 20000);

browserTest('UI-5: removing a model focuses the next Remove (or Add a model); Save and Discard focus the agent heading', async () => {
  await open(async page => {
    await pick(page, 'tse');
    const box = page.getByRole('combobox', { name: 'Add a model' });
    await box.fill('second');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Remove terastor-ai', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Remove second');
    await page.getByRole('button', { name: 'Remove second', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'agent-detail-title');
    await page.getByRole('combobox', { name: 'Add a model' }).fill('third');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Agent settings saved' }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'agent-detail-title');
  });
}, 20000);

browserTest('UI-6: at 375px the list comes first and choosing an agent moves focus to its heading', async () => {
  await open(async page => {
    const list = await page.getByRole('navigation', { name: 'Agents' }).boundingBox(), detail = await page.locator('.pc-agent-detail').boundingBox();
    expect(list!.y).toBeLessThan(detail!.y);
    await pick(page, 'Codex');
    await page.waitForFunction(() => document.activeElement?.id === 'agent-detail-title' && !!document.activeElement.textContent?.includes('Codex'));
  }, { width: 375, height: 800 });
}, 20000);

browserTest('Find an agent filters the list; an agent removed elsewhere says so', async () => {
  await open(async page => {
    const nav = page.getByRole('navigation', { name: 'Agents' });
    await nav.getByRole('searchbox', { name: 'Find an agent' }).fill('tse');
    await page.waitForFunction(() => document.querySelectorAll('nav[aria-label="Agents"] li').length === 1);
    expect(await nav.locator('li').innerText()).toContain('tse');
    await nav.getByRole('searchbox', { name: 'Find an agent' }).fill('');
    await pick(page, 'tse');
    await page.evaluate(() => (window as any).agentsFixture.removeElsewhere('opencode#tse'));
    await page.getByText('Removed elsewhere', { exact: true }).waitFor();
  });
}, 20000);

browserTest('S5: an account no agent uses opens an account-only page with sign-in and Add as agent', async () => {
  await open(async page => {
    await page.getByRole('navigation', { name: 'Agents' }).getByRole('link', { name: /Claude Code · spare/ }).click();
    await page.getByRole('heading', { level: 2, name: /Claude Code · spare/ }).waitFor();
    await page.getByRole('link', { name: 'Add as agent' }).waitFor();
    await page.getByText(/Fix sign-in/).first().waitFor();
    expect(await page.getByRole('combobox').count()).toBe(0);
  });
}, 20000);
