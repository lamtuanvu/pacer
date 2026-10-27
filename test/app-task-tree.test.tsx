import { afterAll, beforeAll, expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { chromium, type Browser } from 'playwright-core';
import { TaskTree, TaskTreeNode } from '../app/src/ds/TaskTreeNode';
import type { TaskNodeView } from '../src/view-model/task-tree';
import { workTree } from '../app/src/screens/session/WorkList';
import { TaskNavigator } from '../app/src/screens/session/TaskNavigator';
import snapshotFixture from './fixtures/ui/snapshot.json';
import type { ClientSnapshot } from '../src/view-model/snapshot';

const leaf = (id: string, over: Partial<TaskNodeView> = {}): TaskNodeView => ({
  id, title: `Task ${id}`, state: { tone: 'info', live: true, label: 'Working' }, active: true, attention: 'none',
  host: { name: 'This Mac', kind: 'local' }, agents: ['codex'], meta: [{ icon: 'time', text: 'running for 4m' }], children: [], ...over,
});
const root = (title = 'Add SSH keepalive to remote runs'): TaskNodeView => leaf('t-1', {
  title, attention: 'warn', attentionLabel: 'Review requested', branch: 'feat/keepalive', tokens: '1.2M tokens', agents: ['codex', 'claude-code'],
  children: [leaf('t-2', { title: 'Write the keepalive test' }), leaf('t-3', { title: 'Document the setting', state: { tone: 'good', live: false, label: 'Completed' }, active: false })],
});
const href = (id: string) => `#/tasks/${id}`;
const card = (node: TaskNodeView, over: Partial<Parameters<typeof TaskTreeNode>[0]> = {}) =>
  renderToString(<TaskTreeNode node={node} density="regular" expanded={false} onToggle={() => {}} href={href} {...over} />);

test('regular_card_shows_facts_without_colour_alone', () => {
  const html = card(root());
  expect(html).toContain('pc-task-node--regular');
  expect(html).toContain('pc-task-node--warn');
  expect(html).toContain('Review requested');
  expect(html).toContain('class="pc-status-dot__label"');
  expect(html).toContain('Working');
  expect(html).toContain('feat/keepalive');
  expect(html).toContain('1.2M tokens');
  expect(html).toContain('running for 4m');
  expect(html).toContain('title="Add SSH keepalive to remote runs"');
  expect(html).toContain('aria-label="2 subtasks of Add SSH keepalive to remote runs"');
  expect(html).toContain('aria-expanded="false"');
  // One link per collapsed card: no nested interactive targets.
  expect(html.match(/<a /g)).toHaveLength(1);
});

test('expanded_card_renders_child_rows_with_controls_target', () => {
  const html = card(root(), { expanded: true, selectedId: 't-3' });
  expect(html).toContain('aria-expanded="true"');
  const controls = html.match(/aria-controls="([^"]+)"/)![1]!;
  expect(html).toContain(`id="${controls}"`);
  expect(html.match(/<a /g)).toHaveLength(3);
  expect(html).toMatch(/href="#\/tasks\/t-3"[^>]*aria-current="page"|aria-current="page"[^>]*href="#\/tasks\/t-3"/);
});

test('pill_never_repeats_the_status_label', () => {
  const failed = leaf('t-6', { state: { tone: 'bad', live: false, label: 'Failed' }, attention: 'bad', attentionLabel: 'Failed' });
  const html = card(failed);
  expect(html).toContain('pc-task-node--bad');
  expect(html).not.toContain('pc-pill');
  expect(html.match(/>Failed</g)).toHaveLength(1);
  expect(card({ ...failed, attentionLabel: 'Checks failed' })).toContain('pc-pill--bad');
});

test('leaf_root_has_no_toggle', () => {
  const html = card(leaf('t-9'));
  expect(html).not.toContain('pc-task-node__toggle');
  expect(html).not.toContain('subtask');
});

test('missing_facts_render_nothing', () => {
  const html = card(leaf('t-5', { meta: [], agents: [] }));
  expect(html).not.toContain('tokens');
  expect(html).not.toContain('pc-task-node__branch');
  expect(html).not.toContain('pc-meta-row');
  expect(html).not.toContain('pc-agent-stack');
  expect(html).not.toContain('pc-pill');
});

test('compact_density_omits_meta_row', () => {
  const html = renderToString(<TaskTreeNode node={root()} density="compact" expanded={false} onToggle={() => {}} href={href} />);
  expect(html).toContain('pc-task-node--compact');
  expect(html).not.toContain('pc-meta-row');
  expect(html).toContain('Working');
});

test('tree_seeds_expansion_for_selected_descendant', () => {
  const html = renderToString(<TaskTree nodes={[root(), leaf('t-8')]} density="compact" href={href} selectedId="t-3" label="Tasks" />);
  expect(html).toContain('aria-label="Tasks"');
  expect(html).toContain('aria-expanded="true"');
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
});

test('work_rows_nest_children_and_omit_unknown_facts', () => {
  const snapshot = structuredClone(snapshotFixture) as unknown as ClientSnapshot;
  const rows = [
    { id: 'w-root', parentId: null, rootId: 'w-root', depth: 0, title: 'Root work', state: 'running', executor: 'codex', rev: 1 },
    { id: 'w-child', parentId: 'w-root', rootId: 'w-root', depth: 1, title: 'Child work', state: 'failed', executor: 'agy', rev: 1 },
    { id: 't-0409', parentId: null, rootId: 't-0409', depth: 0, title: 'Retry budget refresh on 429', state: 'failed', executor: 'agy', rev: 1 },
  ];
  const nodes = workTree(rows, snapshot);
  const root = nodes.find(node => node.id === 'w-root')!;
  expect(root.children.map(child => child.id)).toEqual(['w-child']);
  // Work rows carry no machine or update time; nothing is invented for them.
  expect(root.host).toBeUndefined();
  expect(root.meta.some(item => item.icon === 'time')).toBe(false);
  // Attention follows Needs you: the snapshot's failed item for t-0409 counts, an unlisted child failure does not.
  expect(nodes.find(node => node.id === 't-0409')!.attention).toBe('bad');
  expect(root.children[0]!.attention).toBe('none');
  expect(nodes.find(node => node.id === 't-0409')!.host).toEqual({ name: 'This Mac', kind: 'local' });
  // Without a snapshot the row's own state is the only evidence.
  expect(workTree(rows, null).find(node => node.id === 'w-root')!.children[0]!.attention).toBe('bad');
});

test('navigator_counts_every_task_and_groups_by_activity', () => {
  const html = renderToString(<TaskNavigator selectedId="t-3" nodes={[root(), leaf('t-8', { active: false, state: { tone: 'good', live: false, label: 'Completed' } })]} />);
  expect(html).toMatch(/<strong>Tasks<\/strong><span>4<\/span>/);
  expect(html).toContain('aria-label="Running tasks"');
  expect(html).toContain('aria-label="Completed tasks"');
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
});

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let styles = '';

beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/task-tree-browser.tsx'], target: 'browser' });
  if (!built.success) throw new AggregateError(built.logs);
  const script = await built.outputs[0]!.text();
  styles = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css'].map(path => Bun.file(path).text()))).join('\n');
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(
    `<meta charset="utf-8"><style>${styles}</style><div id="root"></div><script type="module">${script}</script>`,
    { headers: { 'Content-Type': 'text/html' } },
  ) });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 15000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 15000);

browserTest('kids_chip_toggles_with_aria_expanded', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}`);
    const toggle = page.getByRole('button', { name: '2 subtasks of Add SSH keepalive to remote runs' });
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    expect(await page.getByRole('link', { name: /Write the keepalive test/ }).count()).toBe(0);
    await toggle.click();
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    const list = page.locator(`#${await toggle.getAttribute('aria-controls')}`);
    expect(await list.getByRole('link').allTextContents()).toEqual([expect.stringContaining('Write the keepalive test'), expect.stringContaining('Document the setting')]);
    // Keyboard path: focus stays on the toggle and Enter / Space collapse and reopen it.
    await toggle.focus();
    await page.keyboard.press('Enter');
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    await page.keyboard.press('Space');
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await toggle.evaluate(node => node === document.activeElement)).toBe(true);
  } finally { await page.close(); }
}, 20_000);

browserTest('selected_child_has_aria_current', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}?density=compact&selected=t-3`);
    expect(await page.getByRole('button', { name: /^2 subtasks/ }).getAttribute('aria-expanded')).toBe('true');
    const current = page.locator('[aria-current="page"]');
    expect(await current.count()).toBe(1);
    expect(await current.getAttribute('href')).toBe('#/tasks/t-3');
  } finally { await page.close(); }
}, 20_000);

browserTest('expansion_survives_snapshot_refresh', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}`);
    await page.getByRole('button', { name: /^2 subtasks/ }).click();
    await page.evaluate(() => (window as unknown as { refresh(): void }).refresh());
    const toggle = page.getByRole('button', { name: /^3 subtasks of Add SSH keepalive to remote runs \(updated\)/ });
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await page.getByRole('link', { name: /New child/ }).count()).toBe(1);
  } finally { await page.close(); }
}, 20_000);

browserTest('compact_density_fits_272px', async () => {
  const long = 'Rework the remote host keepalive negotiation so that long running sessions survive network changes';
  const node = root(long);
  node.branch = 'feature/a-very-long-unbroken-branch-name-for-narrow-containment-checks';
  node.host = { name: 'a-remote-build-machine-with-a-long-ssh-alias', kind: 'remote' };
  node.children[0]!.title = long;
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage();
    try {
      const markup = renderToString(<TaskTreeNode node={node} density="compact" expanded onToggle={() => {}} selectedId="t-2" href={href} />);
      await page.setContent(`<html data-theme="${theme}"><style>${styles}</style><div id="panel" style="width:272px">${markup}</div></html>`);
      const panel = page.locator('#panel');
      expect(await panel.evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true);
      const overflow = await panel.evaluate(p => {
        const box = p.getBoundingClientRect();
        return [...p.querySelectorAll('*')].filter(n => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5); }).map(n => n.getAttribute('class'));
      });
      expect(overflow).toEqual([]);
      // Titles clip with an ellipsis on one line and keep their full text in title.
      const title = page.locator('.pc-task-node__title');
      expect(await title.getAttribute('title')).toBe(long);
      expect(await title.evaluate(n => getComputedStyle(n).textOverflow)).toBe('ellipsis');
      expect(await title.evaluate(n => n.scrollWidth > n.clientWidth)).toBe(true);
      expect(await page.locator('.pc-task-node__branch').evaluate(n => getComputedStyle(n).whiteSpace)).toBe('nowrap');
      expect(await page.locator('.pc-task-node__child-title').first().evaluate(n => getComputedStyle(n).textOverflow)).toBe('ellipsis');
      // A child's status words never clip; its title gives way instead.
      for (const label of await page.locator('.pc-task-node__child .pc-status-dot__label').all())
        expect(await label.evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true);
      // Compact keeps the desktop control height.
      expect(await page.locator('.pc-task-node__toggle').evaluate(n => n.getBoundingClientRect().height)).toBeLessThanOrEqual(32);
    } finally { await page.close(); }
  }
}, 30_000);
