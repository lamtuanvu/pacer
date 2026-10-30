import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright-core';
import { renderToString } from 'preact-render-to-string';
import { TasksPage } from '../app/src/screens/session/TasksPage';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { taskTree } from '../src/view-model/task-tree';

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/tasks-page-browser.tsx'], target: 'browser' });
  if (!built.success) throw new AggregateError(built.logs);
  const script = await built.outputs[0]!.text();
  const styles = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/styles.css', 'app/src/screens/session/session.css'].map(path => Bun.file(path).text()))).join('\n');
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(
    `<meta charset="utf-8"><style>${styles}</style><div id="root"></div><script type="module">${script}</script>`, { headers: { 'Content-Type': 'text/html' } }) });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 15000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 15000);

browserTest('header_summary_filters_and_counts_follow_the_board', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.url.toString());
    expect(await page.getByRole('heading', { level: 1, name: 'Tasks' }).count()).toBe(1);
    expect(await page.locator('.pc-tasks-page__caption').first().textContent()).toBe('26 root tasks · 2 subtasks · 214k tokens');
    expect((await page.getByRole('tab').allTextContents()).map(text => text.replace(/\s+/g, ' ').trim())).toEqual(['All 26', 'Needs you 1', 'Running 1', 'Accepted 24', 'Stopped 0']);
    expect(await page.getByRole('searchbox', { name: 'Search tasks' }).getAttribute('placeholder')).toBe('Search goal, repo or branch');
    // Paging: twenty roots first, then the rest on request.
    expect(await page.locator('.pc-task-card').count()).toBe(20);
    expect(await page.getByRole('status').filter({ hasText: 'Showing' }).textContent()).toBe('Showing 20 of 26 root tasks');
    await page.getByRole('button', { name: 'Show 6 more' }).click();
    expect(await page.locator('.pc-task-card').count()).toBe(26);
    await page.getByRole('tab', { name: /Needs you/ }).click();
    expect(await page.locator('.pc-task-card').count()).toBe(1);
    await page.getByRole('tab', { name: /^All/ }).click();
    await page.getByRole('searchbox').fill('zzz');
    expect(await page.getByText('No tasks match.').count()).toBe(1);
  } finally { await page.close(); }
}, 30_000);

browserTest('selecting_a_row_updates_the_selected_task_panel_and_new_task_asks_the_shell', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.url.toString());
    const aside = page.getByRole('complementary', { name: 'Selected task' });
    await aside.getByText(/^Root task ·/).waitFor();
    expect(await aside.locator('b').textContent()).toBe('Fix the retry bug');
    await page.locator('.pc-task-card__main').nth(1).click();
    expect(await aside.locator('b').textContent()).toBe('Document the budget store');
    const rootSelection = page.locator('.pc-task-card__main--selected');
    expect(await rootSelection.locator('.pc-task-card__title').evaluate(node => getComputedStyle(node).fontWeight)).toBe('650');
    await rootSelection.hover();
    expect(await rootSelection.evaluate(node => {
      const sample = document.createElement('span'); sample.style.background = 'var(--surface-page)'; node.append(sample);
      const matches = getComputedStyle(node).backgroundColor === getComputedStyle(sample).backgroundColor; sample.remove(); return matches;
    })).toBe(true);
    await page.getByRole('button', { name: /^2 subtasks of/ }).click();
    await page.getByRole('link', { name: 'Working: Curated regression title' }).focus();
    expect(await aside.locator('b').textContent()).toBe('Curated regression title');
    expect(await page.getByRole('link', { name: 'Working: Curated regression title' }).getAttribute('title')).toBe('Write the regression test');
    await page.getByRole('link', { name: /Capture screenshots/ }).focus();
    await aside.getByText(/^Subtask 2 of 2 ·/).waitFor();
    const childSelection = page.locator('.pc-task-card__child--selected');
    expect(await childSelection.locator('.pc-task-card__child-title').evaluate(node => getComputedStyle(node).fontWeight)).toBe('650');
    await childSelection.hover();
    expect(await childSelection.evaluate(node => {
      const sample = document.createElement('span'); sample.style.background = 'var(--surface-page)'; node.append(sample);
      const matches = getComputedStyle(node).backgroundColor === getComputedStyle(sample).backgroundColor; sample.remove(); return matches;
    })).toBe(true);
    expect(await aside.getByRole('link', { name: 'Fix the retry bug' }).count()).toBe(1);
    await page.getByRole('button', { name: 'New task' }).click();
    expect(await page.evaluate(() => (window as unknown as { newTask?: number }).newTask)).toBe(1);
  } finally { await page.close(); }
}, 30_000);

browserTest('filters_wrap_and_nothing_overflows_at_375', async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  try {
    await page.goto(server.url.toString());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const tabs = await page.getByRole('tab').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
    for (const tab of tabs) expect(tab.right).toBeLessThanOrEqual(375);
    // The selected-task panel is a desktop and tablet aid; phones go straight to the task.
    expect(await page.getByRole('complementary', { name: 'Selected task' }).isVisible()).toBe(false);
  } finally { await page.close(); }
}, 30_000);

test('page_renders_header_filters_search_and_empty_state_without_a_browser', () => {
  const html = (nodes: ReturnType<typeof taskTree> | undefined) => renderToString(<TaskContext.Provider value={{ state: { ...initialState(), connected: true } as never, api: { call: async () => ({}) } as never }}>
    <TasksPage nodes={nodes} repos={[]} query={{ repo: null, scope: null } as never} onNew={() => {}} hasOlder={false} loadingOlder={false} onLoadOlder={() => {}} /></TaskContext.Provider>);
  const loaded = html(taskTree({ tasks: [{ id: 'a', goal: 'Fix it', title: 'Fix it', state: 'failed', executor: 'codex', backend: null, worktree: null, updatedAt: Math.floor(Date.now() / 1000) - 60 }] }, { now: Math.floor(Date.now() / 1000) }));
  expect(loaded).toContain('<h1 class="pc-tasks-page__title">Tasks</h1>');
  expect(loaded).toContain('1 root task this week · 0 subtasks');
  for (const word of ['All', 'Needs you', 'Running', 'Accepted', 'Stopped', 'New task', 'Search tasks']) expect(loaded).toContain(word);
  expect(loaded).toContain('Showing 1 of 1 root tasks');
  expect(html(undefined)).toContain('Loading tasks…');
  expect(html([])).toContain('No tasks yet.');
});

 browserTest('selected_brief_stays_one_line_and_shows_duration_linked_work_and_notes', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(server.url.toString());
    const aside = page.getByRole('complementary', { name: 'Selected task' });
    await aside.getByText('Report only. Keep existing routes.').waitFor();
    const title = aside.locator('b').first();
    expect(await title.textContent()).toBe('Fix the retry bug');
    expect(await aside.getByText(/Delegated by Codex via pacer delegate/).count()).toBe(1);
    expect(await title.evaluate(node => getComputedStyle(node).fontWeight)).toBe('700');
    expect(await aside.getByRole('link', { name: 'Open session' }).evaluate(node => node.getBoundingClientRect().height)).toBe(32);
    expect(await aside.getByRole('link', { name: 'Dispatch trace' }).getAttribute('href')).toBe('#/tasks/t-1/trace');
    expect(await title.getAttribute('title')).toContain('Full brief');
    expect(await title.evaluate(node => ({ whiteSpace: getComputedStyle(node).whiteSpace, overflow: getComputedStyle(node).textOverflow, height: node.getBoundingClientRect().height }))).toEqual({ whiteSpace: 'nowrap', overflow: 'ellipsis', height: 19 });
    expect(await aside.locator('.pc-task-aside__caption').first().textContent()).toBe('Root task · Codex · 12m · 214k tokens');
    expect(await aside.getByText('Linked work', { exact: true }).count()).toBe(1);
    expect(await aside.getByText('worktree', { exact: false }).count()).toBeGreaterThan(0);
    expect(await aside.evaluate(node => getComputedStyle(node).top)).toBe('16px');
    const rowTitle = page.locator('.pc-task-card__title').first();
    expect(await rowTitle.textContent()).toBe('Fix the retry bug');
    expect(await rowTitle.getAttribute('title')).toContain('Full brief');
    expect((await rowTitle.getAttribute('title'))!.length).toBeGreaterThan(400);
    expect(await page.getByRole('link', {name:'Notes for Fix the retry bug',exact:true}).count()).toBe(1);
    await page.locator('.pc-task-card').nth(1).getByText('fix/retry', {exact:true}).waitFor();
    expect(await page.locator('.pc-task-card').nth(1).locator('.pc-task-card__tokens').textContent()).toBe('—');
  } finally { await page.close(); }
 }, 30_000);

browserTest('board_row_geometry_and_state_tokens_match_at_both_desktop_sizes_and_themes', async () => {
  const page = await browser.newPage();
  try {
    for (const width of [1440, 1920]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 1080 });
      await page.goto(server.url.toString());
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      const card = page.locator('.pc-task-card').first();
      expect(await card.evaluate(node => ({ padding: getComputedStyle(node).padding, radius: getComputedStyle(node).borderRadius }))).toEqual({ padding: '4px', radius: '12px' });
      expect(await card.locator('.pc-task-card__tokens').first().evaluate(node => ({ width: node.getBoundingClientRect().width, align: getComputedStyle(node).textAlign }))).toEqual({ width: 52, align: 'right' });
      expect(await card.locator('.pc-task-card__action').evaluateAll(nodes => nodes.map(node => [node.getBoundingClientRect().width, node.getBoundingClientRect().height]))).toEqual([[26, 26], [26, 26], [26, 26]]);
      expect(await card.locator('.pc-agent-mark').first().evaluate(node => node.getBoundingClientRect().width)).toBe(18);
      expect(await card.locator('.pc-task-card__branch').first().evaluate(node => getComputedStyle(node).textOverflow)).toBe('ellipsis');
      expect(await card.evaluate(node => {
        const sample = document.createElement('span'); sample.style.background = 'var(--bad-tint)'; sample.style.borderColor = 'var(--bad-line)'; node.append(sample);
        const result = getComputedStyle(node).backgroundColor === getComputedStyle(sample).backgroundColor && getComputedStyle(node).borderColor === getComputedStyle(sample).borderColor; sample.remove(); return result;
      })).toBe(true);
      const aside = page.getByRole('complementary', { name: 'Selected task' });
      await aside.getByText('Report only. Keep existing routes.').waitFor();
      await page.getByRole('button', { name: /^2 subtasks of/ }).click();
      await page.getByRole('link', { name: /Capture screenshots/ }).focus();
      await aside.getByText(/^Subtask 2 of 2 ·/).waitFor();
      const selected = page.locator('.pc-task-card__child--selected');
      expect(await selected.evaluate(node => {
        const sample = document.createElement('span'); sample.style.background = 'var(--surface-page)'; node.append(sample);
        const matches = getComputedStyle(node).backgroundColor === getComputedStyle(sample).backgroundColor; sample.remove(); return matches;
      })).toBe(true);
      if (process.env.PACER_DESIGN_EVIDENCE) await page.screenshot({ path: `${process.env.PACER_DESIGN_EVIDENCE}/fixture-${width}-${theme}.png` });
    }
  } finally { await page.close(); }
}, 30_000);
