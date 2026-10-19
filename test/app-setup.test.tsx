import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import type { SetupChecklist, SetupItem } from '../src/setup/checklist';
import { ApiError, type BrowserApi } from '../app/src/data/api';
import { TaskContext, ErrorMessage } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { SetupView } from '../app/src/screens/setup/Setup';
import { SetupBanner } from '../app/src/screens/setup/SetupBanner';
import { SetupContext } from '../app/src/screens/setup/context';
import { bannerKey, nextOptional, performSetupAction, primaryItem, readDismissal, saveDismissal, SERVICE_CONSENT, DISMISS_KEY } from '../app/src/screens/setup/model';
const service: SetupItem = { id: 'service', title: 'Background service', required: true, status: 'pending', action: 'service.install' };
const agent: SetupItem = { id: 'connect', title: 'Connect planner', required: true, status: 'pending', action: 'agent.connect', agent: 'codex' };
const first: SetupItem = { id: 'first', title: 'First delegation', required: false, status: 'pending', action: 'onboarding.try' };
const check: SetupChecklist = { checkedAt: 1, complete: false, ready: false, items: [service, agent, first] };
const query = { repo: null, scope: null };
const api = { call: async <T,>() => ({} as T) } as unknown as BrowserApi;
const view = (checklist = check) => renderToString(<TaskContext.Provider value={{ api, state: initialState() }}><SetupView checklist={checklist} query={query} /></TaskContext.Provider>);

test('Setup groups statuses in words and gives only the next required action primary weight', () => {
  expect(primaryItem(check)).toBe('service');
  const html = view();
  expect(html).toContain('Required'); expect(html).toContain('Recommended');
  expect(html).toContain('Needs you');
  expect(html.match(/pc-btn--primary/g)).toHaveLength(1);
  expect(html).toMatch(/pc-btn--primary[^>]*>Install service/);
  const done = { ...check, complete: true, items: check.items.map(i => i.required ? { ...i, status: 'done' as const } : i) };
  expect(primaryItem(done)).toBeUndefined();
  expect(view(done)).toContain('Required setup done');
  expect(view(done).match(/pc-btn--primary/g)).toHaveLength(1);
  expect(view(done)).toContain('Go to Home');
  expect(view({ ...check, items: [{ ...service, status: 'failed', detail: 'Install failed' }] })).toContain('Failed');
});
test('terminal-only items show the provider command with a copy action', () => {
  const html = view({ ...check, items: [{ id: 'planner', title: 'Planner', status: 'pending', required: true, command: 'codex login' }] });
  expect(html).toContain('<code>codex login</code>'); expect(html).toContain('Copy command');
});
function harness(yes: boolean, fail = false) {
  const calls: [string, unknown][] = [], dialogs: unknown[] = [], navigation: string[] = [], running: unknown[] = [];
  let refreshes = 0;
  const preview = { files: ['~/.codex/config.toml'], detail: 'Connect hooks', undo: 'pacer uninstall codex' };
  const deps = { api: { call: async <T,>(op: string, params: unknown) => {
    calls.push([op, params]);
    if (fail) throw new ApiError('forbidden', `Live validation D8: ${op} changes the real user environment`, undefined, 403);
    return (op === 'agent.preview' ? preview : { task_id: 'task 1', executor: 'codex', repo: 'sandbox' }) as T;
  } } as BrowserApi, confirm: async (message: string, p?: unknown) => { dialogs.push([message, p]); return yes; }, refresh: () => { refreshes++; }, navigate: (href: string) => navigation.push(href), running: (id: string, executor: string) => running.push([id, executor]) };
  return { deps, calls, dialogs, navigation, running, preview, refreshes: () => refreshes };
}
test('service.install waits for the exact consent and sends consent only on confirmation', async () => {
  for (const yes of [false, true]) {
    const h = harness(yes); await performSetupAction(service, h.deps);
    expect(h.dialogs).toEqual([[SERVICE_CONSENT, undefined]]);
    expect(h.calls).toEqual(yes ? [['service.install', { consent: true }]] : []);
    expect(h.refreshes()).toBe(1);
  }
});
test('agent.connect previews files, detail and undo before consent and never connects on cancellation', async () => {
  for (const yes of [false, true]) {
    const h = harness(yes); await performSetupAction(agent, h.deps);
    expect(h.dialogs).toEqual([['Connect this agent to pacer?', h.preview]]);
    expect(h.calls).toEqual([['agent.preview', { agent: 'codex' }], ...(yes ? [['agent.connect', { agent: 'codex', consent: true }] as [string, unknown]] : [])]);
  }
});
test('first delegation follows the returned task and executor; Skip and Add executor use their own actions', async () => {
  const h = harness(true); await performSetupAction(first, h.deps);
  expect(h.navigation).toEqual(['#/sessions/task%201']); expect(h.running).toEqual([['task 1', 'codex']]);
  await performSetupAction(first, h.deps, true);
  expect(h.calls.at(-1)).toEqual(['onboarding.skip', {}]);
  await performSetupAction({ ...first, action: 'nav:add-executor' }, h.deps);
  expect(h.navigation.at(-1)).toBe('#/settings/add-executor');
});
test('operation failures remain visible in words and still refetch setup', async () => {
  const h = harness(true, true);
  let error: unknown;
  try { await performSetupAction(service, h.deps); } catch (caught) { error = caught; }
  expect(h.refreshes()).toBe(1);
  expect(renderToString(<ErrorMessage error={error} />)).toContain('Live validation D8: service.install changes the real user environment');
  expect(renderToString(<ErrorMessage error={new ApiError('conflict', 'Setup changed. Try again.', 'Refresh setup.')} />)).toContain('Refresh setup.');
});
test('Home banner requires complete but not ready; local dismissal changes when pending items change', () => {
  const complete = { ...check, complete: true };
  expect(nextOptional(check)).toBeUndefined(); expect(nextOptional({ ...complete, ready: true })).toBeUndefined();
  expect(nextOptional(complete)?.title).toBe('First delegation');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } });
  const banner = (c: SetupChecklist) => renderToString(<SetupContext.Provider value={{ checklist: c, refresh: () => {}, setRunning: () => {} }}><SetupBanner /></SetupContext.Provider>);
  try {
    expect(banner(complete)).toContain('Finish setting up pacer: First delegation');
    expect(banner(check)).toBe('');
    saveDismissal(bannerKey(complete)!); expect(saved.has(DISMISS_KEY)).toBe(true);
    expect(readDismissal()).toBe(bannerKey(complete)); expect(banner(complete)).toBe('');
    const next = { ...complete, items: [...complete.items, { ...first, id: 'executor', title: 'Executor' }] };
    expect(bannerKey(next)).not.toBe(bannerKey(complete)); expect(banner(next)).toContain('Continue setup');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
    expect(readDismissal()).toBeNull(); expect(() => saveDismissal('x')).not.toThrow();
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('mutations stay gated while the consent dialog is still open', async () => {
  for (const item of [service, agent]) {
    const h = harness(true);
    let answer!: (yes: boolean) => void;
    h.deps.confirm = () => new Promise<boolean>(resolve => { answer = resolve; });
    const pending = performSetupAction(item, h.deps);
    await Promise.resolve();
    expect(h.calls.map(([op]) => op)).toEqual(item === agent ? ['agent.preview'] : []);
    expect(h.refreshes()).toBe(0);
    answer(true); await pending;
    expect(h.calls.at(-1)?.[0]).toBe(item.action!);
    expect(h.refreshes()).toBe(1);
  }
});

test('the Setup rail entry stays until ready and its status dot only marks required work', async () => {
  const { Rail } = await import('../app/src/shell/Rail');
  const rail = (checklist: SetupChecklist) => renderToString(<SetupContext.Provider value={{ checklist, refresh: () => {}, setRunning: () => {} }}><Rail route={{ name: 'setup', query }} counts={null} /></SetupContext.Provider>);
  expect(rail(check)).toContain('aria-label="Setup · needs you"');
  expect(rail(check)).toContain('pc-rail__dot');
  expect(rail({ ...check, complete: true })).toContain('aria-label="Setup"');
  expect(rail({ ...check, complete: true })).not.toContain('pc-rail__dot');
  expect(rail({ ...check, complete: true, ready: true })).not.toContain('href="#/setup"');
  expect(rail(check)).toContain('aria-label="Settings"');
  expect(rail(check)).not.toContain('Settings · setup needs you');
});

test("first delegation waits for required setup", () => {
  const checklist = { checkedAt: 0, complete: false, ready: false, items: [
    { id: "service", title: "Background service", status: "pending" as const, required: true, action: "service.install" },
    { id: "first", title: "First delegation", status: "pending" as const, required: false, action: "onboarding.try" },
  ] };
  const html = view(checklist);
  expect(html).toContain("Finish the required steps first.");
});

const planner = (options: string[]): SetupItem => ({ id: 'planner', title: 'Planner', required: true, status: 'pending', action: 'setup.init', options, command: 'pacer init' });
test('Setup offers a named button for each installed planner and no terminal command', () => {
  const html = view({ ...check, items: [planner(['claude-code', 'codex', 'cursor', 'opencode'])] });
  for (const name of ['Claude Code', 'Codex', 'Cursor', 'OpenCode']) expect(html).toContain(`>Use ${name}</button>`);
  expect(html).not.toContain('Copy command');
  expect(html.match(/pc-btn--primary/g) ?? []).toHaveLength(1);
});
test('Setup with no installed planner asks for installation without planner buttons', () => {
  const html = view({ ...check, items: [planner([]), { id: 'link', title: 'Link', status: 'done', required: true }] });
  expect(html).toContain('Install Claude Code, Codex, Cursor or OpenCode to plan your work.');
  expect(html).not.toContain('<button'); expect(html).not.toContain('>Link<');
});
test('planner selection initializes only that planner without consent or connections', async () => {
  const h = harness(true);
  await performSetupAction({ ...planner(['codex', 'cursor']), agent: 'cursor' }, h.deps);
  expect(h.calls).toEqual([['setup.init', { planner: 'cursor' }]]);
  expect(h.dialogs).toEqual([]); expect(h.refreshes()).toBe(1);
});
test('one installed planner initializes automatically only once per page, including failures', async () => {
  const { createPlannerAutoInit } = await import('../app/src/screens/setup/model');
  for (const fail of [false, true]) {
    const init = createPlannerAutoInit(), h = harness(true, fail);
    const run = (agent: string) => performSetupAction({ ...planner(['codex']), agent }, h.deps);
    await init(planner([]), run); await init(planner(['codex', 'cursor']), run);
    await init({ ...planner(['codex']), status: 'done' }, run);
    expect(h.calls).toEqual([]);
    let error: unknown;
    try { await init(planner(['codex']), run); } catch (e) { error = e; }
    await init(planner(['codex']), run);
    expect(h.calls).toEqual([['setup.init', { planner: 'codex' }]]);
    expect(h.refreshes()).toBe(1);
    if (fail) expect(renderToString(<ErrorMessage error={error} />)).toContain('setup.init');
  }
});
