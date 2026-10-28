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
  const styles = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css'].map(path => Bun.file(path).text()))).join('\n');
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
    // Removing the only executor of a rule keeps focus on that (now empty) list.
    await page.getByRole('button', { name: 'Remove: Claude Code' }).last().click();
    expect(await active(page)).toBe('Add Claude Code');
    expect(await page.getByText('Add at least one executor to this rule.').count()).toBe(1);
    await page.getByRole('button', { name: 'Remove rule: Task kinds: tests' }).click();
    expect(await active(page)).toBe('Add task-kind rule');
    await page.getByRole('button', { name: 'Add task-kind rule' }).click();
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('data-list-field') === 'kinds')).toBe(true);
  } finally { await page.close(); }
});

browserTest('a failed ladder save after saved rules keeps the error and the unsaved ladder draft', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup-fail`);
    await page.getByRole('group', { name: 'Add to Executors for Everything else' }).getByRole('button', { name: 'Add Codex' }).click();
    await page.getByRole('button', { name: 'Move up: Usable fallback' }).click();
    await page.getByLabel('Profile name').fill('night');
    await page.getByLabel('Reason for change').fill('cheaper');
    expect(await page.locator('.pc-save-bar').textContent()).toContain('3 unsaved changes');
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await page.getByText('Saved executor rules. name taken').waitFor();
    expect(await page.getByTestId('calls').textContent()).toBe('dispatch.config.get,routing.set,strategy.preview,strategy.save');
    // The rules saved and were reloaded; the ladder change, its name and reason are kept for a retry.
    await page.locator('.pc-save-bar', { hasText: '2 unsaved changes' }).waitFor({ timeout: 3000 });
    expect(await page.getByLabel('Profile name').inputValue()).toBe('night');
    expect(await page.locator('#decision-ladder .pc-sortable__label').first().textContent()).toBe('Usable fallback');
  } finally { await page.close(); }
});

browserTest('a change from another client keeps the draft, says so, and Discard loads the saved settings', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    await page.getByRole('group', { name: 'Add to Executors for Everything else' }).getByRole('button', { name: 'Add Codex' }).click();
    await page.locator('#other-client').click();
    await page.getByText('Another client changed these settings.').waitFor();
    const everything = page.locator('[aria-label="Executors for Everything else, in priority order"] .pc-sortable__label');
    expect(await everything.allTextContents()).toEqual(['Claude Code', 'Codex']);
    await page.getByRole('button', { name: 'Discard' }).click();
    expect(await everything.allTextContents()).toEqual(['Codex']);
    expect(await page.getByText('Another client changed these settings.').count()).toBe(0);
  } finally { await page.close(); }
});

browserTest('reverting edits after another client changed the rules follows their saved rules', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url.href}#setup`);
    const add = page.getByRole('group', { name: 'Add to Executors for Everything else' });
    await add.getByRole('button', { name: 'Add Codex' }).click();
    await page.locator('#other-client').click();
    await page.getByText('Another client changed these settings.').waitFor();
    // Undo by hand: the count reaches zero, so the editor must rebase onto the other client's rules.
    await page.getByRole('button', { name: 'Remove: Codex' }).last().click();
    const everything = page.locator('[aria-label="Executors for Everything else, in priority order"] .pc-sortable__label');
    await page.locator('[aria-label="Executors for Task kinds: tests, in priority order"]', { hasText: 'OpenCode' }).waitFor({ timeout: 3000 });
    expect(await everything.allTextContents()).toEqual(['Codex']);
    expect(await page.getByText('Another client changed these settings.').count()).toBe(0);
    expect(await page.locator('[aria-label="Executors for Task kinds: tests, in priority order"] .pc-sortable__label').allTextContents()).toEqual(['OpenCode']);
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
    expect(await page.getByText('Task kinds: tests, docs').count()).toBe(1);
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
    await page.getByLabel('Task', { exact: true }).fill('Fix the login bug');
    await page.getByRole('button', { name: 'Preview selection' }).click();
    await page.getByText('Pacer would choose Codex').waitFor();
    const sent = JSON.parse((await page.getByTestId('sent').textContent())!);
    expect(sent.strategyDraft.from).toBe('default');
    expect(sent.strategyDraft.set.dispatch.steps[0].id).toBe('usable-fallback');
    const card = page.locator('[role="status"]', { hasText: 'Pacer would choose Codex' });
    for (const text of ['Uses your unsaved choice ladder.', 'It matched the Usable fallback step for tests tasks.', 'Another condition applies.', 'Its budget is used up.', 'Planner tokens are not measured yet.'])
      expect(await card.getByText(text).count()).toBeGreaterThan(0);
    expect(await card.textContent()).not.toContain('brand_new_code');
    // Unchecked, the saved settings are explained.
    await useDraft.uncheck();
    await page.getByRole('button', { name: 'Preview selection' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="sent"]')!.textContent!.includes('strategyDraft'));
  } finally { await page.close(); }
});
