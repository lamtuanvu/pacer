import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright-core';

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/sortable-browser.tsx'], target: 'browser' });
  if (!built.success) throw new AggregateError(built.logs);
  const script = await built.outputs[0]!.text();
  const styles = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/styles.css'].map(path => Bun.file(path).text()))).join('\n');
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(
    `<meta charset="utf-8"><style>${styles}</style><div id="root"></div><script type="module">${script}</script>`,
    { headers: { 'Content-Type': 'text/html' } },
  ) });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 15000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 15000);

const order = (page: Page) => page.getByTestId('order').textContent();
const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
const announcement = (page: Page) => page.locator('.pc-sortable [aria-live="polite"]').textContent();

browserTest('sortable_keyboard_reorder keeps focus on the moved item and announces its position', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    await page.getByRole('button', { name: 'Move down: Codex' }).focus();
    await page.keyboard.press('Enter');
    expect(await order(page)).toBe('claude,codex,opencode,cursor');
    expect(await focusedLabel(page)).toBe('Move down: Codex');
    expect(await announcement(page)).toBe('Codex moved to position 2 of 4.');
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    expect(await order(page)).toBe('claude,opencode,cursor,codex');
    // Move down no longer exists at the end, so focus moves to the item's other move control.
    expect(await focusedLabel(page)).toBe('Move up: Codex');
    expect(await announcement(page)).toBe('Codex moved to position 4 of 4.');
    await page.keyboard.press('Enter');
    expect(await order(page)).toBe('claude,opencode,codex,cursor');
    expect(await focusedLabel(page)).toBe('Move up: Codex');
    await page.getByRole('button', { name: 'Remove: OpenCode' }).click();
    expect(await order(page)).toBe('claude,codex,cursor');
    expect(await focusedLabel(page)).toBe('Remove: Codex');
    expect(await announcement(page)).toBe('OpenCode removed.');
  } finally { await page.close(); }
});

browserTest('pointer drag reorders by the handle', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    const handles = page.locator('.pc-sortable__handle');
    const from = (await handles.nth(0).boundingBox())!;
    const to = (await page.locator('.pc-sortable__item').nth(2).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, to.y + to.height * 0.75, { steps: 8 });
    await page.mouse.up();
    expect(await order(page)).toBe('claude,opencode,codex,cursor');
    expect(await announcement(page)).toBe('Codex moved to position 3 of 4.');
  } finally { await page.close(); }
});

browserTest('save bar counts changes and discard restores the saved order', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    expect(await page.getByRole('button', { name: 'Discard' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Move up: Claude Code' }).click();
    expect(await page.locator('.pc-save-bar').textContent()).toContain('1 unsaved change');
    expect(await page.locator('.pc-save-bar .pc-btn--primary').count()).toBe(1);
    await page.getByRole('button', { name: 'Discard' }).click();
    expect(await order(page)).toBe('codex,claude,opencode,cursor');
    expect(await page.getByRole('button', { name: 'Discard' }).count()).toBe(0);
  } finally { await page.close(); }
});

browserTest('narrow layout keeps rows and the save bar inside the viewport', async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 720 } });
  try {
    await page.goto(server.url.href);
    await page.getByRole('button', { name: 'Move down: Codex' }).click();
    for (const selector of ['.pc-sortable__item', '.pc-save-bar']) {
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
    const move = (await page.getByRole('button', { name: 'Move down: Codex' }).boundingBox())!;
    expect(move.height).toBeGreaterThanOrEqual(44);
  } finally { await page.close(); }
});

const active = (page: Page) => page.evaluate(() => {
  const node = document.activeElement as HTMLElement | null;
  return node?.getAttribute('aria-label') ?? (node?.dataset.executorPool !== undefined ? 'pool' : node?.textContent ?? node?.tagName);
});

browserTest('a clean save bar takes no space and is not a landmark', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    const bar = page.locator('.pc-save-bar');
    const box = (await bar.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(1);
    expect(box.height).toBeLessThanOrEqual(1);
    expect(await bar.getAttribute('role')).toBeNull();
    await page.getByRole('button', { name: 'Move down: Codex' }).click();
    expect(await bar.getAttribute('role')).toBe('region');
    expect((await bar.boundingBox())!.height).toBeGreaterThan(20);
  } finally { await page.close(); }
});

const defaultList = '[aria-label="Default list, in priority order"] .pc-sortable__label';
const titles = (page: Page, selector: string) => page.locator(selector).evaluateAll(nodes => nodes.map(node => node.getAttribute('title')));
const editLadder = (page: Page) => page.getByRole('button', { name: 'Edit choice method' }).click();

browserTest('focus stays in place after adding from the pool, removing the last agent and using the default list again', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    const pool = page.getByRole('group', { name: 'Add to Agents for Task kinds: tests' });
    await pool.getByRole('button', { name: 'Add Claude Code' }).focus();
    await page.keyboard.press('Enter');
    expect(await active(page)).toBe('Add OpenCode');
    await page.keyboard.press('Enter');
    expect(await active(page)).toBe('Add to Agents for Task kinds: tests');
    // Removing the only agent of the default list keeps focus on its pool.
    await page.locator('[aria-label="Default list, in priority order"]').getByRole('button', { name: 'Remove: Claude Code' }).click();
    expect(await active(page)).toBe('Add Claude Code');
    expect(await page.getByText('Add at least one agent to the default list.').count()).toBe(1);
    await page.getByRole('button', { name: 'Use the default list for Task kinds: tests' }).click();
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-rule-add'))).toBe(true);
    await page.getByRole('button', { name: 'Give task kinds their own list' }).click();
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('data-list-field') === 'kinds')).toBe(true);
  } finally { await page.close(); }
});

browserTest('a failed choice-method save after saved lists keeps the error and the unsaved ladder draft', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup-fail`);
    await page.getByRole('group', { name: 'Add to Default list' }).getByRole('button', { name: 'Add Codex' }).click();
    await editLadder(page);
    await page.getByRole('button', { name: 'Move up: Usable fallback' }).click();
    expect(await page.locator('.pc-save-bar').textContent()).toContain('New profile');
    expect(await page.locator('.pc-save-bar').textContent()).toContain('Name the new profile under How Pacer chooses.');
    await page.getByLabel('Profile name').fill('night');
    // Lists and ladder are both dirty, so the scope names both.
    expect(await page.locator('.pc-save-bar .pc-save-bar__scope').textContent()).toBe(' · Default list and night');
    await page.getByLabel('Reason for change').fill('cheaper');
    expect(await page.locator('.pc-save-bar').textContent()).toContain('2 unsaved changes');
    expect(await page.locator('#decision-ladder').textContent()).toContain('Save the choice method as a new profile');
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await page.getByText('Saved the agent lists. name taken').waitFor();
    expect(await page.getByTestId('calls').textContent()).toBe('dispatch.config.get,routing.set,strategy.preview,strategy.save');
    // The lists saved and were reloaded; the ladder change, its name and reason are kept for a retry.
    await page.locator('.pc-save-bar', { hasText: '1 unsaved change' }).waitFor({ timeout: 3000 });
    expect(await page.getByLabel('Profile name').inputValue()).toBe('night');
    expect(await page.locator('#decision-ladder .pc-sortable__label').first().textContent()).toBe('Usable fallback');
  } finally { await page.close(); }
});

browserTest('a change from another client keeps the draft, says so, and Discard loads the saved settings', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    await page.getByRole('group', { name: 'Add to Default list' }).getByRole('button', { name: 'Add Codex' }).click();
    await page.locator('#other-client').click();
    await page.getByText('Another client changed these settings.').waitFor();
    expect(await titles(page, defaultList)).toEqual(['Claude Code', 'Codex']);
    await page.getByRole('button', { name: 'Discard' }).click();
    expect(await titles(page, defaultList)).toEqual(['Codex']);
    expect(await page.getByText('Another client changed these settings.').count()).toBe(0);
  } finally { await page.close(); }
});

browserTest('reverting edits after another client changed the lists follows their saved lists', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    await page.getByRole('group', { name: 'Add to Default list' }).getByRole('button', { name: 'Add Codex' }).click();
    await page.locator('#other-client').click();
    await page.getByText('Another client changed these settings.').waitFor();
    // Undo by hand: the count reaches zero, so the editor must rebase onto the other client's lists.
    await page.locator('[aria-label="Default list, in priority order"]').getByRole('button', { name: 'Remove: Codex' }).click();
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)].map(node => node.getAttribute('title')).join() === 'Codex', defaultList, { timeout: 3000 });
    expect(await page.getByText('Another client changed these settings.').count()).toBe(0);
    const tests = '[aria-label="Agents for Task kinds: tests, in priority order"]';
    await page.locator(tests, { hasText: 'OpenCode' }).waitFor({ timeout: 3000 });
    expect(await titles(page, `${tests} .pc-sortable__label`)).toEqual(['OpenCode']);
  } finally { await page.close(); }
});

browserTest('task kinds and ladder lists accept typed commas and spaces', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    const kinds = page.getByLabel('List 1 task kinds');
    await kinds.click(); await kinds.press('End');
    await page.keyboard.type(', docs');
    expect(await kinds.inputValue()).toBe('tests, docs');
    expect(await page.getByRole('heading', { name: 'tests, docs tasks · in order' }).count()).toBe(1);
    expect(await page.locator('.pc-save-bar').textContent()).toContain('1 unsaved change');
    await editLadder(page);
    await page.getByText('Edit step 1').click();
    const prefer = page.getByLabel('Prefer these models').first();
    await prefer.click();
    await page.keyboard.type('provider/a, provider/b');
    expect(await prefer.inputValue()).toBe('provider/a, provider/b');
    await prefer.blur();
    expect(await prefer.inputValue()).toBe('provider/a, provider/b');
  } finally { await page.close(); }
});

browserTest('Try a task explains the route with the unsaved choice ladder', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#try`);
    await editLadder(page);
    await page.getByRole('button', { name: 'Move up: Usable fallback' }).click();
    await page.getByLabel('Task', { exact: true }).fill('Fix the login bug');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByText('Would go to', { exact: true }).waitFor();
    const sent = JSON.parse((await page.getByTestId('sent').textContent())!);
    expect(sent.strategyDraft.from).toBe('default');
    expect(sent.strategyDraft.set.dispatch.steps[0].id).toBe('usable-fallback');
    const card = page.locator('.pc-route-result', { has: page.getByText('Would go to', { exact: true }) });
    expect(await card.getAttribute('role')).toBeNull();
    expect(await card.getByText('Matched: Step 2 · Usable fallback', { exact: true }).count()).toBe(1);
    expect(await page.locator('#dispatch-preview [role="status"]').first().textContent()).toBe('Pacer would choose Codex');
    expect(await card.getByText('Uses your unsaved choice ladder.').count()).toBe(1);
    expect(await card.textContent()).not.toContain('brand_new_code');
  } finally { await page.close(); }
});

browserTest('Try a task uses dispatch.preview with saved settings when explain is unavailable', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#try-preview`);
    await editLadder(page);
    await page.getByRole('button', { name: 'Move up: Usable fallback' }).click();
    expect(await page.getByText('See where a task would go, using saved settings and recent readings.', { exact: false }).count()).toBe(1);
    await page.getByLabel('Task', { exact: true }).fill('Check saved settings');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByText('Preview result', { exact: true }).waitFor();
    expect(await page.getByTestId('called').textContent()).toBe('dispatch.preview');
    expect(JSON.parse((await page.getByTestId('sent').textContent())!)).not.toHaveProperty('strategyDraft');
    await page.getByLabel('Task', { exact: true }).fill('A different task');
    await page.getByText('Preview result', { exact: true }).waitFor({ state: 'hidden' });
  } finally { await page.close(); }
});

for (const discard of [false, true]) {
  browserTest(`Try a task omits strategyDraft for a ${discard ? 'discarded' : 'clean'} ladder`, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${server.url.href}#try`);
      if (discard) {
        await editLadder(page);
        await page.getByRole('button', { name: 'Move up: Usable fallback' }).click();
        await page.locator('.pc-save-bar', { hasText: '1 unsaved change' }).waitFor();
        await page.getByRole('button', { name: 'Discard', exact: true }).click();
        await page.locator('.pc-save-bar', { hasText: 'No unsaved changes' }).waitFor();
      }
      await page.getByLabel('Task', { exact: true }).fill('Check the route');
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await page.getByText('Would go to', { exact: true }).waitFor();
      expect(await page.getByTestId('called').textContent()).toBe('dispatch.explain');
      expect(JSON.parse((await page.getByTestId('sent').textContent())!)).not.toHaveProperty('strategyDraft');
      await page.getByLabel('Task', { exact: true }).fill('A different task');
      await page.getByText('Would go to', { exact: true }).waitFor({ state: 'hidden' });
      expect(await page.locator('#dispatch-preview [role="status"]').first().textContent()).toBe('');
    } finally { await page.close(); }
  });
}

browserTest('Try a task names an eligible fallback without a chosen agent', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#try-no-choice`);
    await page.getByLabel('Task', { exact: true }).fill('Check available executors');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    const card = page.locator('.pc-route-result', { has: page.getByText('Also considered', { exact: true }) });
    await card.waitFor();
    expect(await card.textContent()).toContain('Codex · team');
    expect(await card.textContent()).toContain('Could take it.');
    expect(await card.textContent()).not.toContain('the choice above');
  } finally { await page.close(); }
});

browserTest('without a saved profile, Try a task explains the saved settings', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#try-no-saved`);
    await editLadder(page);
    await page.getByRole('button', { name: 'Move up: Usable fallback' }).click();
    await page.getByLabel('Task', { exact: true }).fill('Fix the login bug');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByText('Would go to').waitFor();
    expect(await page.getByTestId('sent').textContent()).not.toContain('strategyDraft');
  } finally { await page.close(); }
});

browserTest('task-kind lists use roving tabs with counts and show one named panel', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    const tabs = page.getByRole('tablist', { name: 'Task kinds with their own list' });
    expect(await tabs.getByRole('tab', { selected: true }).textContent()).toBe('tests 1');
    expect(await page.getByRole('tabpanel').count()).toBe(1);
    // A kind on the default list gets its own list, starting from the default list.
    await page.getByRole('button', { name: 'Give docs its own list' }).click();
    expect(await tabs.getByRole('tab', { selected: true }).textContent()).toBe('docs 1');
    expect(await page.getByRole('button', { name: 'Give docs its own list' }).count()).toBe(0);
    await tabs.getByRole('tab', { selected: true }).focus();
    await page.keyboard.press('Home');
    expect(await tabs.getByRole('tab', { selected: true }).textContent()).toBe('tests 1');
    expect(await tabs.getByRole('tab', { selected: true }).evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(await tabs.getByRole('tab', { selected: true }).textContent()).toBe('docs 1');
    await page.getByRole('group', { name: 'Add to Agents for Task kinds: docs' }).getByRole('button', { name: 'Add Codex' }).click();
    expect(await tabs.getByRole('tab', { selected: true }).textContent()).toBe('docs 2');
    // A new list counts once, whatever is added to it before saving.
    expect(await page.locator('.pc-save-bar').textContent()).toContain('1 unsaved change');
    expect(await page.locator('.pc-save-bar').textContent()).toContain('List for docs tasks');
    expect(await page.getByRole('tabpanel').count()).toBe(1);
  } finally { await page.close(); }
});

browserTest('768px agent labels remain readable and move buttons never overlap them', async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 900 } });
  try {
    await page.goto(`${server.url.href}#setup`);
    await page.getByRole('group', { name: 'Add to Default list' }).getByRole('button', { name: 'Add Codex' }).click();
    const rows = page.locator('#executor-eligibility .pc-sortable__item');
    for (const row of await rows.all()) {
      const label = (await row.locator('.pc-sortable__label').boundingBox())!;
      const actions = (await row.locator('.pc-sortable__actions').boundingBox())!;
      expect(label.width).toBeGreaterThan(60);
      expect(actions.y >= label.y + label.height || actions.x >= label.x + label.width).toBe(true);
    }
    expect(await page.locator('#executor-eligibility .pc-executor-pool__row').count()).toBe(1);
    expect(await page.getByRole('link', { name: '+ Add an agent' }).first().getAttribute('href')).toBe('#/settings/add-executor');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
  } finally { await page.close(); }
});

browserTest('a repository list opens from Repository lists and switching is locked while it has changes', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#scope`);
    const lists = page.locator('#dispatcher-scope');
    await lists.getByText('repo-a', { exact: true }).waitFor();
    expect(await lists.getByText('1 of 1 can take work').count()).toBe(1);
    await lists.getByRole('button', { name: 'Edit the repo-a list' }).click();
    await page.getByRole('heading', { name: 'repo-a list' }).waitFor();
    await page.getByText('Has its own list', { exact: true }).waitFor();
    expect(await page.getByLabel('Repository', { exact: true }).count()).toBe(1);
    // The picker button carries the name itself, so no separate hidden label is announced before it.
    expect(await page.locator('.dispatcher-repo-picker').evaluate(node => [...node.querySelectorAll('label, .sr-only')].length)).toBe(0);
    await page.getByRole('button', { name: 'Add Claude Code' }).click();
    const back = page.getByRole('button', { name: 'Back to the default list' });
    await page.getByRole('button', { name: 'Back to the default list', disabled: true }).waitFor({ timeout: 3000 });
    expect(await page.getByText('Save or discard your changes to switch lists.').isVisible()).toBe(true);
    expect(await back.getAttribute('aria-describedby')).toBe('dispatcher-scope-reason');
    expect(await page.locator('.pc-save-bar').textContent()).toContain('repo-a list');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Back to the default list', disabled: false }).waitFor({ timeout: 3000 });
    await back.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Repository lists' }).waitFor();
    await page.getByRole('heading', { name: 'Default list · every repository' }).waitFor();
  } finally { await page.close(); }
});

browserTest('Preview stays enabled and links an empty-task field error without calling the service', async () => {
  const page=await browser.newPage();
  try {
    await page.goto(`${server.url.href}#try`);
    const preview=page.getByRole('button',{name:'Preview',exact:true}),task=page.getByLabel('Task',{exact:true});
    expect(await preview.isEnabled()).toBe(true);
    await preview.click();
    expect(await task.getAttribute('aria-invalid')).toBe('true');
    const errorId=await task.getAttribute('aria-describedby');
    expect(errorId).toBeTruthy();
    expect(await page.locator(`[id="${errorId}"]`).textContent()).toBe('Describe the task to preview where it would go.');
    expect(await page.getByTestId('called').textContent()).toBe('');
    await task.fill('Check the route');
    expect(await task.getAttribute('aria-invalid')).not.toBe('true');
    await preview.click();
    await page.getByText('Would go to',{exact:true}).waitFor();
    expect(await page.getByTestId('called').textContent()).toBe('dispatch.explain');
  } finally {await page.close();}
});

browserTest('ladder icon actions preserve move focus, announcements and numbered circles', async () => {
  const page=await browser.newPage();
  try {
    await page.goto(`${server.url.href}#try`);
    const ladder=page.locator('#decision-ladder');
    // The summary ladder ends with what happens when nobody fits.
    expect(await ladder.locator('.pc-hub-ladder .pc-ladder-number').allTextContents()).toEqual(['1','2','·']);
    await editLadder(page);
    const steps=ladder.locator('.pc-sortable .pc-ladder-number');
    expect(await steps.allTextContents()).toEqual(['1','2']);
    // Ladder step names wrap instead of truncating.
    expect(await ladder.locator('.pc-sortable__label').first().evaluate(node => getComputedStyle(node).whiteSpace)).toBe('normal');
    await ladder.getByRole('button',{name:'Move up: Usable fallback'}).focus();
    await page.keyboard.press('Enter');
    expect(await focusedLabel(page)).toBe('Move down: Usable fallback');
    expect(await ladder.locator('.pc-sortable__status').textContent()).toBe('Usable fallback moved to position 1 of 2.');
    expect(await steps.allTextContents()).toEqual(['1','2']);
    await ladder.getByRole('button',{name:'Remove: Usable fallback'}).click();
    expect(await ladder.locator('.pc-sortable__status').textContent()).toBe('Usable fallback removed.');
    expect(await steps.allTextContents()).toEqual(['1']);
    // The last step cannot be removed, so focus falls back to the list itself.
    expect(await focusedLabel(page)).toBe('Ladder steps, first match wins');
  } finally {await page.close();}
});

browserTest('Overview opens Preview a task from its header action and puts the cursor in Task', async () => {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  try {
    await page.goto(`${server.url.href}#overview`);
    const open=page.getByRole('button',{name:'Preview a task'});
    await open.waitFor();
    expect(await open.getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#dispatch-preview').count()).toBe(0);
    await open.click();
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Task');
    expect(await open.getAttribute('aria-expanded')).toBe('true');
    await open.click();
    expect(await page.locator('#dispatch-preview').count()).toBe(0);
  } finally {await page.close();}
});

for(const width of [1440,768,375])browserTest(`Try a task input layout at ${width}px`,async()=>{
  const page=await browser.newPage({viewport:{width,height:900}});
  try {
    await page.goto(`${server.url.href}#try`);
    const row=page.locator('.dispatcher-preview-row');
    const [repo,kind,task]=await Promise.all([row.getByLabel('Repository'),row.getByLabel('Task kind'),row.getByLabel('Task',{exact:true})].map(item=>item.boundingBox()));
    if(width===1440){
      expect(repo!.y).toBe(task!.y);
      expect(kind!.x).toBeGreaterThan(repo!.x);
      expect(task!.height).toBe(32);
    }else{
      expect(kind!.y).toBeGreaterThan(repo!.y);
      expect(task!.y).toBeGreaterThan(kind!.y);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }finally{await page.close();}
});

browserTest('agent rows expose the name and the move controls for assistive technology', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    const row = page.locator('[aria-label="Default list, in priority order"] .pc-sortable__row').first();
    expect(await row.locator('.pc-sortable__label').textContent()).toBe('Claude Code');
    const accessible = await row.ariaSnapshot();
    expect(accessible).toContain('Claude Code');
    expect(accessible).toContain('Remove: Claude Code');
  } finally { await page.close(); }
});
