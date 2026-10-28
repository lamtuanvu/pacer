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

browserTest('focus stays in place after adding from the pool, removing the last executor and removing a rule', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    const pool = page.getByRole('group', { name: 'Add to Executors for Task kinds: tests' });
    await pool.getByRole('button', { name: 'Add Claude Code' }).focus();
    await page.keyboard.press('Enter');
    expect(await active(page)).toBe('Add OpenCode');
    await page.keyboard.press('Enter');
    expect(await active(page)).toBe('Add to Executors for Task kinds: tests');
    await page.getByRole('tab', { name: 'Everything else' }).click();
    // Removing the only executor of a rule keeps focus on its pool.
    await page.getByRole('button', { name: 'Remove: Claude Code' }).last().click();
    expect(await active(page)).toBe('Add Claude Code');
    expect(await page.getByText('Add at least one executor to this rule.').count()).toBe(1);
    await page.getByRole('tab', { name: 'tests', exact: false }).click();
    await page.getByRole('button', { name: 'Remove rule: Task kinds: tests' }).click();
    expect(await page.getByRole('tab', { name: 'Everything else' }).evaluate(node => node === document.activeElement)).toBe(true);
    await page.getByRole('button', { name: 'Add task-kind rule' }).click();
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('data-list-field') === 'kinds')).toBe(true);
  } finally { await page.close(); }
});

browserTest('a failed ladder save after saved rules keeps the error and the unsaved ladder draft', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup-fail`);
    await page.getByRole('tab', { name: 'Everything else' }).click();
    await page.getByRole('group', { name: 'Add to Executors for Everything else' }).getByRole('button', { name: 'Add Codex' }).click();
    await page.getByRole('button', { name: 'Move up: Usable fallback' }).click();
    expect(await page.locator('.pc-save-bar').textContent()).toContain('New saved setup');
    expect(await page.locator('.pc-save-bar').textContent()).toContain('Name the new saved setup in step 3.');
    expect(await page.locator('.pc-save-bar .pc-save-bar__scope').textContent()).not.toContain('default');
    await page.getByLabel('Setup name').fill('night');
    // Rules and ladder are both dirty, so the scope names both.
    expect(await page.locator('.pc-save-bar .pc-save-bar__scope').textContent()).toBe(' · Global list for Everything else and night');
    await page.getByLabel('Reason for change').fill('cheaper');
    expect(await page.locator('.pc-save-bar').textContent()).toContain('2 unsaved changes');
    expect(await page.locator('#decision-ladder').textContent()).toContain('Save the ladder as a new saved setup');
    expect(await page.locator('#decision-ladder').textContent()).not.toContain('profile');
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await page.getByText('Saved executor rules. name taken').waitFor();
    expect(await page.getByTestId('calls').textContent()).toBe('dispatch.config.get,routing.set,strategy.preview,strategy.save');
    // The rules saved and were reloaded; the ladder change, its name and reason are kept for a retry.
    await page.locator('.pc-save-bar', { hasText: '1 unsaved change' }).waitFor({ timeout: 3000 });
    expect(await page.getByLabel('Setup name').inputValue()).toBe('night');
    expect(await page.locator('#decision-ladder .pc-sortable__label').first().textContent()).toBe('Usable fallback');
  } finally { await page.close(); }
});

browserTest('a change from another client keeps the draft, says so, and Discard loads the saved settings', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    await page.getByRole('tab', { name: 'Everything else' }).click();
    await page.getByRole('group', { name: 'Add to Executors for Everything else' }).getByRole('button', { name: 'Add Codex' }).click();
    await page.locator('#other-client').click();
    await page.getByText('Another client changed these settings.').waitFor();
    const everything = page.locator('[aria-label="Executors for Everything else, in priority order"] .pc-sortable__label');
    expect(await everything.evaluateAll(nodes => nodes.map(node => node.getAttribute('title')))).toEqual(['Claude Code', 'Codex']);
    await page.getByRole('button', { name: 'Discard' }).click();
    expect(await everything.evaluateAll(nodes => nodes.map(node => node.getAttribute('title')))).toEqual(['Codex']);
    expect(await page.getByText('Another client changed these settings.').count()).toBe(0);
  } finally { await page.close(); }
});

browserTest('reverting edits after another client changed the rules follows their saved rules', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    await page.getByRole('tab', { name: 'Everything else' }).click();
    const add = page.getByRole('group', { name: 'Add to Executors for Everything else' });
    await add.getByRole('button', { name: 'Add Codex' }).click();
    await page.locator('#other-client').click();
    await page.getByText('Another client changed these settings.').waitFor();
    // Undo by hand: the count reaches zero, so the editor must rebase onto the other client's rules.
    await page.getByRole('button', { name: 'Remove: Codex' }).last().click();
    const everything = page.locator('[aria-label="Executors for Everything else, in priority order"] .pc-sortable__label');
    // The rebase happens once the editor sees a zero count, after this render.
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Executors for Everything else, in priority order"] .pc-sortable__label')].map(node => node.getAttribute('title')).join() === 'Codex', undefined, { timeout: 3000 });
    expect(await everything.evaluateAll(nodes => nodes.map(node => node.getAttribute('title')))).toEqual(['Codex']);
    expect(await page.getByText('Another client changed these settings.').count()).toBe(0);
    await page.getByRole('tab', { name: 'tests', exact: false }).click();
    await page.locator('[aria-label="Executors for Task kinds: tests, in priority order"]', { hasText: 'OpenCode' }).waitFor({ timeout: 3000 });
    expect(await page.locator('[aria-label="Executors for Task kinds: tests, in priority order"] .pc-sortable__label').evaluateAll(nodes => nodes.map(node => node.getAttribute('title')))).toEqual(['OpenCode']);
  } finally { await page.close(); }
});

browserTest('task kinds and ladder lists accept typed commas and spaces', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    const kinds = page.getByLabel('Rule 1 task kinds');
    await kinds.click(); await kinds.press('End');
    await page.keyboard.type(', docs');
    expect(await kinds.inputValue()).toBe('tests, docs');
    expect(await page.getByRole('heading', { name: 'tests, docs tasks · in order' }).count()).toBe(1);
    expect(await page.locator('.pc-save-bar').textContent()).toContain('1 unsaved change');
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
    expect(await page.getByLabel('Use my unsaved choice ladder').count()).toBe(0);
    await page.getByRole('button', { name: 'Move up: Usable fallback' }).click();
    const useDraft = page.getByLabel('Use my unsaved choice ladder');
    expect(await useDraft.isChecked()).toBe(true);
    expect(await useDraft.getAttribute('aria-describedby')).toBeTruthy();
    expect(await page.getByRole('checkbox', { name: 'Use my unsaved choice ladder', exact: true }).count()).toBe(1);
    await page.getByLabel('Task', { exact: true }).fill('Fix the login bug');
    await page.getByRole('button', { name: 'Preview selection' }).click();
    await page.getByText('Would go to', { exact: true }).waitFor();
    const sent = JSON.parse((await page.getByTestId('sent').textContent())!);
    expect(sent.strategyDraft.from).toBe('default');
    expect(sent.strategyDraft.set.dispatch.steps[0].id).toBe('usable-fallback');
    const card = page.locator('.pc-route-result', { has: page.getByText('Would go to', { exact: true }) });
    expect(await card.getAttribute('role')).toBeNull();
    expect(await card.getByText('Matched: Step 2 · Usable fallback', { exact: true }).count()).toBe(1);
    expect(await page.locator('#dispatch-preview [role="status"]').textContent()).toBe('Pacer would choose Codex');
    for (const text of ['Uses your unsaved choice ladder.', 'It matched the Usable fallback step for tests tasks.', 'Another condition applies.', 'Its budget is used up.', 'Planner tokens are not measured yet.'])
      expect(await card.getByText(text).count()).toBeGreaterThan(0);
    expect(await card.textContent()).not.toContain('brand_new_code');
    // Unchecked, the saved settings are explained.
    await useDraft.uncheck();
    await page.getByRole('button', { name: 'Preview selection' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="sent"]')!.textContent!.includes('strategyDraft'));
  } finally { await page.close(); }
});


browserTest('Try a task uses dispatch.preview with saved settings when explain is unavailable', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#try-preview`);
    await page.getByRole('button', { name: 'Move up: Usable fallback' }).click();
    expect(await page.getByLabel('Use my unsaved choice ladder').count()).toBe(0);
    expect(await page.getByText('See where a task would go, using saved settings and recent readings.', { exact: false }).count()).toBe(1);
    await page.getByLabel('Task', { exact: true }).fill('Check saved settings');
    await page.getByRole('button', { name: 'Preview selection' }).click();
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
        await page.getByRole('button', { name: 'Move up: Usable fallback' }).click();
        await page.getByLabel('Use my unsaved choice ladder').waitFor();
        await page.getByRole('button', { name: 'Discard', exact: true }).click();
        await page.getByLabel('Use my unsaved choice ladder').waitFor({ state: 'hidden' });
      }
      await page.getByLabel('Task', { exact: true }).fill('Check the route');
      await page.getByRole('button', { name: 'Preview selection' }).click();
      await page.getByText('Would go to', { exact: true }).waitFor();
      expect(await page.getByTestId('called').textContent()).toBe('dispatch.explain');
      expect(JSON.parse((await page.getByTestId('sent').textContent())!)).not.toHaveProperty('strategyDraft');
      await page.getByLabel('Task', { exact: true }).fill('A different task');
      await page.getByText('Would go to', { exact: true }).waitFor({ state: 'hidden' });
      expect(await page.locator('#dispatch-preview [role="status"]').textContent()).toBe('');
    } finally { await page.close(); }
  });
}

browserTest('Try a task names an eligible fallback without a chosen executor', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#try-no-choice`);
    await page.getByLabel('Task', { exact: true }).fill('Check available executors');
    await page.getByRole('button', { name: 'Preview selection' }).click();
    const card = page.locator('.pc-route-result', { has: page.getByText('Also considered', { exact: true }) });
    await card.waitFor();
    expect(await card.textContent()).toContain('Codex · team');
    expect(await card.textContent()).toContain('Could take it.');
    expect(await card.textContent()).not.toContain('the choice above');
  } finally { await page.close(); }
});

browserTest('without a saved strategy, Try a task explains the saved settings and says why', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#try-no-saved`);
    await page.getByRole('button', { name: 'Move up: Usable fallback' }).click();
    expect(await page.getByLabel('Use my unsaved choice ladder').count()).toBe(0);
    await page.getByText('Save the choice ladder once to try unsaved changes here.').waitFor();
    await page.getByLabel('Task', { exact: true }).fill('Fix the login bug');
    await page.getByRole('button', { name: 'Preview selection' }).click();
    await page.getByText('Would go to').waitFor();
    expect(await page.getByTestId('sent').textContent()).not.toContain('strategyDraft');
  } finally { await page.close(); }
});


browserTest('task-kind chips use roving tabs and counts and show one named panel', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    const tabs = page.getByRole('tablist', { name: 'Task type' });
    expect(await tabs.getByRole('tab', { selected: true }).textContent()).toBe('tests 1');
    expect(await page.getByRole('tabpanel').count()).toBe(1);
    await tabs.getByRole('tab', { selected: true }).focus();
    await page.keyboard.press('End');
    expect(await tabs.getByRole('tab', { selected: true }).textContent()).toBe('Everything else 1');
    expect(await tabs.getByRole('tab', { selected: true }).evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(await tabs.getByRole('tab', { selected: true }).textContent()).toBe('tests 1');
    await page.getByRole('button', { name: 'Add Claude Code' }).click();
    expect(await tabs.getByRole('tab', { selected: true }).textContent()).toBe('tests 2');
    expect(await page.locator('.pc-save-bar').textContent()).toContain('1 unsaved change');
    expect(await page.locator('.pc-save-bar').textContent()).toContain('Global list for tests tasks');
    expect(await page.getByText('There is no fallback.', { exact: false }).count()).toBe(0);
  } finally { await page.close(); }
});

browserTest('768px executor labels remain readable and move buttons never overlap them', async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 900 } });
  try {
    await page.goto(`${server.url.href}#setup`);
    await page.getByRole('button', { name: 'Add Claude Code' }).click();
    const rows = page.locator('#executor-eligibility .pc-sortable__item');
    for (const row of await rows.all()) {
      const label = (await row.locator('.pc-sortable__label').boundingBox())!;
      const actions = (await row.locator('.pc-sortable__actions').boundingBox())!;
      expect(label.width).toBeGreaterThan(60);
      expect(actions.y >= label.y + label.height || actions.x >= label.x + label.width).toBe(true);
    }
    expect(await page.locator('.pc-executor-pool__row').count()).toBe(1);
    expect(await page.getByRole('link', { name: '+ Set up a new executor' }).getAttribute('href')).toBe('#/settings/add-executor');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
  } finally { await page.close(); }
});

browserTest('scope pressed buttons switch repositories and explain a dirty lock', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#scope`);
    const scope = page.getByRole('group', { name: 'Scope', exact: true });
    expect(await scope.getByRole('button', { name: 'All repositories' }).getAttribute('aria-pressed')).toBe('true');
    await scope.getByRole('button', { name: 'One repository' }).focus();
    await page.keyboard.press('Space');
    expect(await scope.getByRole('button', { name: 'One repository' }).getAttribute('aria-pressed')).toBe('true');
    await page.getByText('Has its own list', { exact: true }).waitFor();
    expect(await page.getByLabel('Repository', { exact: true }).count()).toBe(1);
    await page.getByRole('button', { name: 'Add Claude Code' }).click();
    // The dirty lock arrives after the editor reports its change, so wait for it.
    await scope.getByRole('button', { name: 'All repositories', disabled: true }).waitFor({ timeout: 3000 });
    expect(await page.getByText('Save or discard your changes to switch scope.').isVisible()).toBe(true);
    // The reason is linked to the group, so screen readers hear it on the disabled buttons.
    expect(await page.getByRole('group', { name: 'Scope' }).getAttribute('aria-describedby')).toBe('dispatcher-scope-reason');
    expect(await scope.getByRole('button', { name: 'One repository' }).isDisabled()).toBe(true);
    expect(await page.locator('.pc-save-bar').textContent()).toContain('repo-a list');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await scope.getByRole('button', { name: 'One repository', disabled: false }).waitFor({ timeout: 3000 });
    await scope.getByRole('button', { name: 'All repositories' }).focus();
    await page.keyboard.press('Enter');
    expect(await scope.getByRole('button', { name: 'All repositories' }).getAttribute('aria-pressed')).toBe('true');
  } finally { await page.close(); }
});

browserTest('Preview selection stays enabled and links an empty-task field error without calling the service', async () => {
  const page=await browser.newPage();
  try {
    await page.goto(`${server.url.href}#try`);
    const preview=page.getByRole('button',{name:'Preview selection'}),task=page.getByLabel('Task',{exact:true});
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
    expect(await ladder.locator('.pc-ladder-number').allTextContents()).toEqual(['1','2']);
    await ladder.getByRole('button',{name:'Move up: Usable fallback'}).focus();
    await page.keyboard.press('Enter');
    expect(await focusedLabel(page)).toBe('Move down: Usable fallback');
    expect(await ladder.locator('.pc-sortable__status').textContent()).toBe('Usable fallback moved to position 1 of 2.');
    expect(await ladder.locator('.pc-ladder-number').allTextContents()).toEqual(['1','2']);
    await ladder.getByRole('button',{name:'Remove: Usable fallback'}).click();
    expect(await ladder.locator('.pc-sortable__status').textContent()).toBe('Usable fallback removed.');
    expect(await ladder.locator('.pc-ladder-number').allTextContents()).toEqual(['1']);
    // The last step cannot be removed, so focus falls back to the list itself.
    expect(await focusedLabel(page)).toBe('Ladder steps, first match wins');
  } finally {await page.close();}
});

browserTest('overview reads repository choices and Switch setup focuses the final Saved setups section', async () => {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  try {
    await page.goto(`${server.url.href}#overview`);
    const strip=page.getByRole('region',{name:'Current setup'});
    await strip.getByText('1 repository',{exact:true}).waitFor();
    expect(await strip.getByRole('link',{name:'Planner & pacing'}).getAttribute('href')).toBe('#/settings/planner');
    await strip.getByRole('link',{name:'Switch setup'}).click();
    expect(await page.evaluate(()=>document.activeElement?.id)).toBe('saved-profiles');
    expect(await page.locator('main>section').last().getAttribute('id')).toBe('saved-profiles');
    expect(await page.locator('.pc-saved-setups__row--active strong').textContent()).toBe('default');
    const icon=await page.locator('.pc-saved-setups .pc-identicon').first().boundingBox();
    expect(icon?.width).toBe(28);
    expect(icon?.height).toBe(28);
  } finally {await page.close();}
});

for(const width of [1440,768,375])browserTest(`Try a task input layout at ${width}px`,async()=>{
  const page=await browser.newPage({viewport:{width,height:900}});
  try {
    await page.goto(`${server.url.href}#try`);
    const form=page.locator('.dispatcher-preview-form');
    const fields=form.locator('.dispatcher-preview-row .pc-field');
    const boxes=await Promise.all([0,1,2].map(index=>fields.nth(index).boundingBox()));
    if(width===1440){
      expect(boxes[0]!.width).toBe(200);expect(boxes[1]!.width).toBe(140);
      expect(boxes[0]!.y).toBe(boxes[2]!.y);
      expect((await form.getByLabel('Task',{exact:true}).boundingBox())!.height).toBe(32);
      const tier = (await form.getByLabel('Minimum model tier').boundingBox())!;
      const tools = (await form.getByLabel('Needs tools').boundingBox())!;
      expect(tier.width).toBeLessThanOrEqual(200);
      expect(tools.x).toBeGreaterThanOrEqual(tier.x + tier.width);
    }else{
      expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);
      expect(boxes[2]!.y).toBeGreaterThan(boxes[1]!.y);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  }finally{await page.close();}
});

browserTest('saved setups and current setup adapt to a 450px container at a 768px viewport', async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 1024 } });
  try {
    await page.goto(`${server.url.href}#overview`);
    // Match the settings canvas beside the sidebar, independently of viewport breakpoints.
    await page.locator('main').evaluate(node => { node.style.width = '450px'; });
    await page.locator('.pc-saved-setups__row').first().waitFor();
    const row = page.locator('.pc-saved-setups__row').first();
    const [name, summary, action] = await Promise.all([
      row.locator(':scope > strong').boundingBox(), row.locator(':scope > span').nth(1).boundingBox(), row.locator(':scope > div').boundingBox(),
    ]);
    expect(summary!.y).toBeGreaterThanOrEqual(name!.y + name!.height);
    expect(summary!.x).toBe(name!.x);
    expect(summary!.width).toBeGreaterThan(150);
    expect(summary!.x + summary!.width).toBeLessThanOrEqual(action!.x);
    const cells = page.locator('.pc-current-setup__cell');
    await cells.last().getByText('1 repository', { exact: true }).waitFor();
    const boxes = await Promise.all([0, 1, 2].map(index => cells.nth(index).boundingBox()));
    for (let index = 1; index < boxes.length; index++) {
      expect(boxes[index]!.y).toBeGreaterThanOrEqual(boxes[index - 1]!.y + boxes[index - 1]!.height);
      expect(boxes[index]!.width).toBe(boxes[0]!.width);
    }
    for (const id of ['native-control', 'model-choices', 'saved-profiles']) {
      const heading = page.locator(`#${id} > .u3-heading h2`);
      expect(await heading.evaluate(node => {
        const style = getComputedStyle(node);
        return [style.fontSize, style.lineHeight, style.fontWeight, style.textTransform];
      })).toEqual(['16px', '22px', '650', 'none']);
    }
  } finally { await page.close(); }
});

browserTest('executor rows separate name and account for assistive technology', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    await page.getByRole('tab', { name: 'Everything else' }).click();
    const label = page.locator('[aria-label="Executors for Everything else, in priority order"] .pc-sortable__label').first();
    // The separator is visually hidden but stays in the text that screen readers announce.
    expect((await label.textContent())!.replace(/\s+/g, ' ')).toMatch(/^Claude Code · /);
  } finally { await page.close(); }
});
