import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright-core';

// Dispatcher › Overview, Who can run what and Profiles in a real browser: layout at 1440 and 375 px in light and
// dark, real headings and aria-current, and the new interactions (filters, Right now actions, profile comparison).
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser, script = '', styles = '';
beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/dispatcher-tabs.tsx'], target: 'browser', minify: true });
  if (!built.success) throw new AggregateError(built.logs);
  script = await built.outputs[0]!.text();
  styles = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/ds/feedback.css', 'app/src/styles.css'].map(path => Bun.file(path).text()))).join('\n');
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 20000);
afterAll(async () => { await browser?.close(); }, 20000);

async function open(tab: string, fn: (page: Page) => Promise<void>, viewport = { width: 1440, height: 1000 }, colorScheme: 'light' | 'dark' = 'light') {
  const page = await browser.newPage({ viewport, colorScheme });
  page.setDefaultTimeout(3000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>${styles}</style><div id="app"></div>`);
    await page.evaluate(value => { location.hash = value; }, tab);
    await page.addScriptTag({ content: script });
    await page.getByRole('navigation', { name: 'Dispatcher sections' }).waitFor();
    await fn(page);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}
const calls = (page: Page) => page.evaluate(() => (window as any).hubFixture.calls()) as Promise<[string, any][]>;
const headings = (page: Page) => page.getByRole('heading', { level: 2 }).allTextContents();
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const TABS = [
  { hash: 'dispatcher', name: 'Overview', ready: 'Agents and models', sections: ['Right now', 'Model size for each difficulty', 'Agents and models'] },
  { hash: 'rules', name: 'Who can run what', ready: 'How Pacer chooses', sections: ['Right now', 'Default list · every repository', 'By task kind', 'Repository lists', 'How Pacer chooses'] },
  { hash: 'profiles', name: 'Profiles', ready: 'What switching to cheap-first changes', sections: ['Saved profiles · 3', 'What switching to cheap-first changes'] },
];
for (const item of TABS) for (const width of [1440, 375]) for (const scheme of ['light', 'dark'] as const) {
  browserTest(`${item.name} stays inside the page at ${width}px (${scheme}) with one title, real headings and aria-current`, async () => {
    await open(item.hash, async page => {
      await page.getByRole('heading', { name: item.ready }).waitFor();
      expect(await page.getByRole('heading', { level: 1 }).allTextContents()).toEqual(['Dispatcher']);
      const current = page.getByRole('navigation', { name: 'Dispatcher sections' }).locator('[aria-current="page"]');
      expect(await current.count()).toBe(1);
      expect((await current.innerText()).trim()).toBe(item.name);
      expect(await headings(page)).toEqual(expect.arrayContaining(item.sections));
      expect(await fits(page)).toBe(true);
      // Nothing inside the page reaches past the viewport, even where a table or long id would.
      const outside = await page.evaluate(() => [...document.querySelectorAll('.pc-hub *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => node.className).slice(0, 5));
      expect(outside).toEqual([]);
      if (scheme === 'dark') expect(await page.evaluate(() => getComputedStyle(document.querySelector('.pc-card')!).backgroundColor)).not.toBe('rgb(255, 255, 255)');
    }, { width, height: 1000 }, scheme);
  }, 20000);
}

browserTest('Overview: Right now names the planner fallback, its actions go to the right agents and the filters narrow the table', async () => {
  await open('dispatcher', async page => {
    const now = page.getByRole('region', { name: 'Right now' });
    await now.getByText('Complex tasks go to the planner, because no other agent that can take work has a frontier model.').waitFor();
    expect(await now.getByRole('link', { name: 'Add a frontier model' }).getAttribute('href')).toBe('#/settings/agents?agent=opencode%23tse');
    expect(await now.getByRole('link', { name: 'Planner fallback settings' }).getAttribute('href')).toBe('#/settings/agents?agent=claude-code');
    const tiles = page.getByRole('list', { name: 'Who gets each difficulty' }).getByRole('listitem');
    expect(await tiles.count()).toBe(3);
    expect(await tiles.nth(2).innerText()).toContain('Claude Code on opus, through the tier fallback. Uses planner quota.');
    const rows = page.locator('.pc-hub-table tbody tr');
    expect(await rows.count()).toBe(6);
    await page.getByRole('button', { name: /^Unrated/ }).click();
    expect(await page.getByRole('button', { name: /^Unrated/ }).getAttribute('aria-pressed')).toBe('true');
    expect(await rows.count()).toBe(2);
    expect(await rows.first().getByRole('link', { name: /Set its size/ }).getAttribute('href')).toBe('#/settings/agents?agent=opencode%23local');
    await page.getByRole('button', { name: /^Pick their own/ }).click();
    expect(await rows.count()).toBe(1);
    expect(await rows.first().innerText()).toContain('Uses its default model, gpt-5.5, for every difficulty');
    // Status pills use the shared readiness vocabulary.
    await page.getByRole('button', { name: /^All/ }).click();
    expect(await page.locator('.pc-hub-table').getByText('Cannot take work').count()).toBe(1);
    expect(await page.locator('.pc-hub-table').locator('.pc-pill', { hasText: /Off$/ }).count()).toBe(1);
  });
}, 20000);

browserTest('Overview: picking a size keeps the order, Refresh all re-reads every agent and the save bar appears only with changes', async () => {
  await open('dispatcher', async page => {
    await page.getByRole('heading', { name: 'Agents and models' }).waitFor();
    expect(await page.getByRole('region', { name: 'Unsaved changes' }).count()).toBe(0);
    await page.getByRole('radiogroup', { name: 'Complex tasks' }).getByRole('radio', { name: 'Small' }).click();
    for (const difficulty of ['Simple', 'Standard', 'Complex'])
      expect(await page.getByRole('radiogroup', { name: `${difficulty} tasks` }).getByRole('radio', { checked: true }).innerText()).toBe('Small');
    expect(await page.getByText('2 unsaved changes').count()).toBe(1);
    await page.getByRole('button', { name: 'Discard' }).click();
    expect(await page.getByText('unsaved change').count()).toBe(0);
    await page.getByRole('button', { name: 'Refresh all accounts: models, sign-in and usage' }).click();
    await page.waitForFunction(() => (window as any).hubFixture.calls().filter(([op, p]: [string, any]) => op === 'executor.models.available' && p.refresh).length === 6);
    expect((await calls(page)).some(([op]) => op === 'limits.refresh')).toBe(true);
  });
}, 20000);

browserTest('Who can run what: Right now explains the default list and its action adds the agents that can take work', async () => {
  await open('rules', async page => {
    const now = page.getByRole('region', { name: 'Right now' });
    await now.getByText('Only 1 agent of 3 in the default list can take work.').waitFor();
    expect(await now.innerText()).toContain('Codex is out of quota and BytePlus is off, so tasks outside repositories with their own list go to Local model.');
    expect(await now.innerText()).toContain("tse and oc-go-free can take work but aren't in this list.");
    await now.getByRole('button', { name: 'Add tse and oc-go-free' }).click();
    const list = page.locator('[aria-label="Default list, in priority order"] .pc-sortable__label');
    expect(await list.evaluateAll(nodes => nodes.map(node => node.getAttribute('title')))).toEqual(['Codex', 'BytePlus', 'Local model', 'tse', 'oc-go-free']);
    expect(await now.getByRole('button').count()).toBe(0);
    await page.locator('.pc-save-bar', { hasText: '2 unsaved changes' }).waitFor();
    expect(await page.locator('.pc-save-bar').textContent()).toContain('Lists save into the active profile, default. Repository lists are kept separately.');
    await page.getByRole('button', { name: 'Save lists' }).click();
    await page.waitForFunction(() => (window as any).hubFixture.routing().rules[0].executors.length === 5);
    // Repository lists show who can take work and open the repository's own list.
    const repos = page.locator('#dispatcher-scope');
    expect(await repos.getByText('1 of 2 can take work').count()).toBe(1);
    // Try a task puts the cursor in the preview form.
    await page.getByRole('button', { name: 'Try a task' }).click();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Task');
  });
}, 20000);

browserTest('Profiles: the comparison reads both profiles, Compare and Switch act on one profile, and Try a task uses it', async () => {
  await open('profiles', async page => {
    const panel = page.getByRole('region', { name: 'What switching to cheap-first changes' });
    await panel.getByText('Default list', { exact: true }).waitFor();
    expect(await panel.innerText()).toContain('Codex, BytePlus, Local model');
    expect(await panel.innerText()).toContain('Local model, BytePlus, Codex');
    expect(await panel.innerText()).toContain('Cheapest first: Local model, BytePlus, Codex');
    expect(await panel.innerText()).toContain('Unchanged: the planner (Claude Code), the planner keeps 15% back');
    expect((await calls(page)).filter(([op]) => op === 'strategy.preview').map(([, p]) => p.draft.from).sort()).toEqual(['cheap-first', 'default']);
    await page.getByRole('button', { name: 'Compare save-claude' }).click();
    const other = page.getByRole('region', { name: 'What switching to save-claude changes' });
    await other.getByText('Keeps 30% back').waitFor();
    expect(await page.locator('.pc-hub-profile--selected code').innerText()).toBe('save-claude');
    await other.getByRole('button', { name: 'Try a task with it' }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Task');
    await page.getByLabel('Task', { exact: true }).fill('Write the docs');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByText('Uses the save-claude profile, not the active one.').waitFor();
    expect((await calls(page)).find(([op]) => op === 'dispatch.explain')![1].strategyDraft).toEqual({ from: 'save-claude' });
    await other.getByRole('button', { name: 'Switch to save-claude' }).click();
    await page.waitForFunction(() => (window as any).hubFixture.calls().some(([op, p]: [string, any]) => op === 'strategy.use' && p.name === 'save-claude'));
  });
}, 20000);

browserTest('Profiles: Save current as a profile checks the name before saving a copy of the active profile', async () => {
  await open('profiles', async page => {
    await page.getByRole('button', { name: 'Save current as a profile' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save current as a profile' });
    const name = dialog.getByLabel('Profile name');
    await name.fill('cheap-first');
    await dialog.getByText('A profile with this name exists; choose another name.').waitFor();
    expect(await dialog.getByRole('button', { name: 'Save profile' }).isDisabled()).toBe(true);
    await name.fill('Bad Name');
    await dialog.getByText('Use lowercase letters, numbers and hyphens', { exact: false }).waitFor();
    await name.fill('weekend');
    await dialog.getByLabel('What is it for?').fill('Quiet weekends');
    await dialog.getByRole('button', { name: 'Save profile' }).click();
    await page.waitForFunction(() => (window as any).hubFixture.calls().some(([op]: [string]) => op === 'strategy.save'));
    expect((await calls(page)).find(([op]) => op === 'strategy.save')![1]).toEqual({ name: 'weekend', draft: { from: 'default', description: 'Quiet weekends' }, reason: 'Quiet weekends' });
    expect(await page.getByRole('dialog').count()).toBe(0);
  });
}, 20000);
