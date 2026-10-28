import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { renderToString } from 'preact-render-to-string';
import { SettingRow } from '../app/src/ds/SettingRow';
import { SettingsNav } from '../app/src/ds/SettingsNav';
import { Checkbox, TextInput } from '../app/src/ds/Controls';
import { SegmentedControl } from '../app/src/ds/Patterns';
import { Button } from '../app/src/ds/Button';
import { SettingsPanel } from '../app/src/shell/SettingsPanel';
import { SettingsGeneral } from '../app/src/screens/settings/General';
import { TaskContext } from '../app/src/screens/task-shared';
import { ActionContext } from '../app/src/data/action-context';
import { initialState } from '../app/src/data/store';
import { resolveRoute, titleFor, type Route } from '../app/src/router';
import { settingsPageTitle, updateNoticeHiddenOn } from '../app/src/settings-pages';
import { settings, executor } from './fixtures/ui/settings';

const query = { repo: null, scope: null };
const state = { ...initialState(), snapshot: { executors: [], accounts: [], hosts: [], repos: [] } } as any;
const render = (child: any, s = state) => renderToString(<TaskContext.Provider value={{ state: s, api: {} as any }}>{child}</TaskContext.Provider>);
const attr = (html: string, pattern: RegExp) => pattern.exec(html)?.[1];

test('setting_row_labels_its_control_and_describes_it', () => {
  const html = renderToString(<SettingRow label="Planner reserve" description="Kept back for planning and review"><TextInput type="number" value="10" /></SettingRow>);
  const labelId = attr(html, /<label[^>]*id="([^"]+)"[^>]*>Planner reserve<\/label>/);
  const controlId = attr(html, /<label[^>]*for="([^"]+)"[^>]*>Planner reserve<\/label>/);
  const descriptionId = attr(html, /<p[^>]*id="([^"]+)"[^>]*>Kept back for planning and review<\/p>/);
  expect(labelId && controlId && descriptionId).toBeTruthy();
  expect(html).toMatch(new RegExp(`<input(?=[^>]*id="${controlId}")(?=[^>]*aria-describedby="${descriptionId}")`));
  // The label and description reach the control once; no group repeats them.
  expect(html).not.toContain('role="group"');
});

test('setting_row_keeps_existing_descriptions_on_the_control', () => {
  const html = renderToString(<SettingRow label="Threshold" description="Percent used"><TextInput aria-describedby="threshold-hint" /></SettingRow>);
  const descriptionId = attr(html, /<p[^>]*id="([^"]+)"[^>]*>Percent used<\/p>/);
  expect(html).toContain(`aria-describedby="threshold-hint ${descriptionId}"`);
});

test('setting_row_labels_and_describes_a_group_control', () => {
  const html = renderToString(<SettingRow label="Policy" description="How work spreads across executors">
    <SegmentedControl label="Pacing policy" value="even" options={[{ value: 'even', label: 'Even' }]} onChange={() => {}} />
  </SettingRow>);
  const labelId = attr(html, /id="([^"]+)"[^>]*>Policy</);
  const descriptionId = attr(html, /<p[^>]*id="([^"]+)"[^>]*>How work spreads/);
  expect(html).not.toContain('<label');
  expect(html).toMatch(new RegExp(`role="group"(?=[^>]*aria-labelledby="${labelId}")(?=[^>]*aria-describedby="${descriptionId}")`));
});

test('setting_row_never_renames_a_button', () => {
  const html = renderToString(<SettingRow label="Setup checks" description="Check setup"><Button>Run checks</Button></SettingRow>);
  expect(html).not.toContain('<label');
  expect(html).toContain('>Run checks</button>');
  expect(html).not.toMatch(/<button[^>]*aria-labelledby/);
});

test('setting_row_status_is_words_not_colour', () => {
  const html = renderToString(<SettingRow label="Executors" status={{ tone: 'bad', label: '1 needs attention' }}><span>x</span></SettingRow>);
  expect(html).toContain('1 needs attention');
  expect(html).toContain('pc-pill--bad');
  const plain = renderToString(<SettingRow label="Executors"><span>x</span></SettingRow>);
  expect(plain).not.toContain('pc-pill');
  expect(plain).not.toContain('aria-describedby');
});

test('settings_nav_marks_one_current_page_in_labelled_groups', () => {
  const html = renderToString(<SettingsNav label="Settings" groups={[
    { id: 'a', label: 'Dispatch', items: [{ id: 'x', label: 'Overview', href: '#/settings', icon: 'sliders' }, { id: 'y', label: 'Accounts', href: '#/settings/accounts', icon: 'accounts', current: true, badge: { text: '2', label: '2 accounts' } }] },
    { id: 'b', label: 'App', items: [{ id: 'z', label: 'Diagnostics', href: '#/settings/diagnostics', icon: 'diagnostics' }] },
  ]} />);
  expect(html).toMatch(/^<nav[^>]*aria-label="Settings"/);
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toMatch(/<a(?=[^>]*href="#\/settings\/accounts")(?=[^>]*aria-current="page")/);
  for (const group of ['Dispatch', 'App']) {
    const id = attr(html, new RegExp(`id="([^"]+)"[^>]*>${group}<`));
    expect(html).toContain(`aria-labelledby="${id}"`);
  }
  expect(html).not.toMatch(/<h\d/);
  expect(html).toContain('<span class="sr-only">2 accounts</span>');
});

const navOrder = (html: string) => [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]);

test('settings panel groups pages and keeps a stable keyboard order', () => {
  const html = renderToString(<SettingsPanel route={{ name: 'settings', query }} counts={null} />);
  expect(navOrder(html)).toEqual([
    '#/settings', '#/settings/executors', '#/settings/add-executor', '#/settings/accounts', '#/settings/dispatcher', '#/settings/planner', '#/settings/machine', '#/settings/hosts',
    '#/settings/app', '#/settings/diagnostics',
  ]);
  expect(html).not.toMatch(/tabindex="[1-9]/);
  expect(html.indexOf('>Dispatch<')).toBeLessThan(html.indexOf('>App<'));
  expect(html).toContain('>Overview<');
  expect(html).toContain('>Budget &amp; pacing<');
  expect(html).toContain('>App preferences<');
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  for (const [item] of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)) expect(item).toContain('<svg');
});

test('embedded settings panel renders only the nav so the SidePanel owns the landmark', () => {
  const route = { name: 'settings', section: 'planner', query } as Route;
  const embedded = renderToString(<SettingsPanel route={route} counts={null} embedded />);
  expect(embedded).not.toContain('<aside');
  expect(embedded).toMatch(/<nav[^>]*aria-label="Settings pages"/);
  expect(embedded.match(/aria-current="page"/g)).toHaveLength(1);
  const standalone = renderToString(<SettingsPanel route={route} counts={null} />);
  expect(standalone.match(/<aside[^>]*aria-label="Settings"/g)).toHaveLength(1);
});

test('legacy app sections open App preferences and keep their deep links', () => {
  for (const section of ['app', 'updates', 'notifications', 'appearance']) {
    const route = resolveRoute(`#/settings/${section}`) as Route;
    expect(route).toMatchObject({ name: 'settings', section });
    expect(settingsPageTitle(section)).toBe('App preferences');
    const html = renderToString(<SettingsPanel route={route} counts={null} />);
    expect(html).toMatch(/<a(?=[^>]*href="#\/settings\/app")(?=[^>]*aria-current="page")/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  }
  expect(settingsPageTitle('planner')).toBe('Budget & pacing');
  expect(settingsPageTitle()).toBe('Overview');
  expect(titleFor({ name: 'settings', section: 'diagnostics', query } as Route)).toContain('Diagnostics');
});

test('App preferences holds updates, notifications and appearance as headed sections', () => {
  for (const section of ['app', 'updates', 'notifications', 'appearance']) {
    const html = render(<SettingsGeneral section={section} initialData={settings} />);
    for (const heading of ['Updates', 'Notifications', 'Appearance']) expect(html).toMatch(new RegExp(`<h2[^>]*>${heading}</h2>`));
    expect(html).toContain('id="updates"');
    expect(html).toContain('id="notifications"');
    expect(html).toContain('id="appearance"');
    expect(html).toContain('aria-label="Notify me about"');
    expect(html).not.toContain('Pacing policy');
    expect(html).not.toContain('Run checks');
  }
});

test('Overview groups every page with its description and attention status', () => {
  const down = { ...executor, state: 'down' };
  const html = render(<SettingsGeneral initialData={settings} />, { ...state, snapshot: { ...state.snapshot, executors: [down] } });
  for (const group of ['Dispatch', 'App']) expect(html).toMatch(new RegExp(`<h2[^>]*>${group}</h2>`));
  for (const href of ['#/settings/executors', '#/settings/accounts', '#/settings/dispatcher', '#/settings/planner', '#/settings/machine', '#/settings/hosts', '#/settings/app', '#/settings/diagnostics']) expect(html).toContain(`href="${href}"`);
  expect(html).not.toContain('href="#/settings/updates"');
  expect(html).toContain('1 needs attention');
  expect(html).toContain('pc-pill--bad');
  expect(html).not.toContain('Pacing policy');
});

test('Budget & pacing and App preferences rows use the shared SettingRow grammar', () => {
  const budget = render(<SettingsGeneral section="planner" initialData={settings} />);
  expect((budget.match(/class="pc-setting-row"/g) ?? []).length).toBe(4);
  expect(budget).not.toContain('class="u3-setting"');
  const app = render(<SettingsGeneral section="app" initialData={settings} />);
  expect((app.match(/class="pc-setting-row"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  expect(app).toContain('class="pc-checkbox pc-checkbox--bare"');
  const diagnostics = render(<SettingsGeneral section="diagnostics" />);
  expect(diagnostics).toContain('class="pc-setting-row"');
  // The issue count appears once, in the results summary, never in the row.
  expect(diagnostics).not.toContain('pc-pill');
  expect(diagnostics).not.toContain('next routing decision');
  expect(budget).toContain('next routing decision');
  expect(app).not.toContain('next routing decision');
  expect(diagnostics).toContain('Run checks');
  expect((diagnostics.match(/pc-btn--primary/g) ?? []).length).toBe(1);
});

test('existing settings actions send the same operations', async () => {
  const { options } = await import('preact');
  const handlers = new Map<string, (value: string) => void>();
  const old = options.vnode;
  options.vnode = node => {
    old?.(node);
    const props = node.props as any;
    if (typeof props?.label === 'string' && typeof props.onChange === 'function' && Array.isArray(props.options)) handlers.set(props.label, props.onChange);
  };
  const calls: unknown[] = [];
  const runner = { run: async (_key: string, request: any) => { calls.push({ op: request.op, params: request.params }); return { status: 'done' }; }, result: () => ({}) } as any;
  const mount = (section: string) => renderToString(<ActionContext.Provider value={runner}><TaskContext.Provider value={{ state, api: {} as any }}><SettingsGeneral section={section} initialData={{ ...settings, notifications: { level: 'all' } }} /></TaskContext.Provider></ActionContext.Provider>);
  try {
    // Let each operation settle before the next control is used.
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    mount('planner');
    handlers.get('Pacing policy')!('even');
    await settle();
    handlers.get('Account mode')!('fill');
    await settle();
    mount('app');
    handlers.get('Notify me about')!('important');
    await settle();
  } finally { options.vnode = old; }
  expect(calls).toEqual([
    { op: 'config.set', params: { key: 'pacing.policy', value: 'even' } },
    { op: 'config.set', params: { key: 'pacing.accounts', value: 'fill' } },
    { op: 'notifications.set', params: { level: 'important' } },
  ]);
});

const browserPath = process.env.PACER_TEST_BROWSER;
test.skipIf(!browserPath)('settings_nav_tab_order_follows_groups', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    const css = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css'].map(path => Bun.file(path).text()))).join('\n');
    await page.setContent(`<style>${css}</style>${renderToString(<SettingsPanel route={{ name: 'settings', section: 'planner', query }} counts={null} />)}`);
    const order: string[] = [];
    for (let i = 0; i < 10; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement?.getAttribute('href') ?? '')); }
    expect(order).toEqual(navOrder(await page.content()));
    expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('solid');
    expect(await page.locator('[aria-current="page"]').getAttribute('href')).toBe('#/settings/planner');
    expect(await page.getByRole('navigation', { name: 'Settings' }).ariaSnapshot()).toContain('Budget & pacing');
  } finally { await browser.close(); }
}, 20_000);

test('the floating update notice stays hidden on every App preferences route only', () => {
  for (const section of ['app', 'updates', 'notifications', 'appearance']) expect(updateNoticeHiddenOn({ name: 'settings', section })).toBe(true);
  for (const route of [{ name: 'settings' }, { name: 'settings', section: 'planner' }, { name: 'settings', section: 'diagnostics' }, { name: 'overview' }, { name: 'hosts' }]) expect(updateNoticeHiddenOn(route)).toBe(false);
});

test('menu and Overview show the same executor and host attention', () => {
  const snapshot = { ...state.snapshot, executors: [{ ...executor, state: 'blocked' }], hosts: [{ alias: 'devbox', state: 'needs_setup' }], accounts: [{}, {}] };
  const menu = renderToString(<SettingsPanel route={{ name: 'settings', query }} counts={null} snapshot={snapshot} />);
  const overview = render(<SettingsGeneral initialData={settings} />, { ...state, snapshot });
  for (const words of ['1 blocked', '1 needs setup']) { expect(menu).toContain(words); expect(overview).toContain(words); }
  expect(menu).toContain('2 accounts');
  // Neutral counts belong to the menu; Overview statuses are attention only.
  expect(overview).not.toContain('2 accounts');
});

test('update, reserve and threshold controls send the same operations', async () => {
  const { options } = await import('preact');
  const handlers: Record<string, (event?: any) => void> = {};
  const old = options.vnode;
  options.vnode = node => {
    old?.(node);
    const props = node.props as any;
    if (props?.children === 'Check now' && props.onClick) handlers.check = props.onClick;
    if (props?.className === 'pc-checkbox__input' && 'checked' in props && props.onChange) handlers.autoCheck = props.onChange;
    if (props?.['aria-label'] === 'Planner reserve (%)' && props.onChange) handlers.reserve = props.onChange;
    if (props?.type === 'number' && props.max === '100' && props.onChange) handlers.threshold = props.onChange;
  };
  const calls: unknown[] = [];
  const runner = { run: async (_key: string, request: any) => { calls.push({ op: request.op, params: request.params }); return { status: 'done' }; }, result: () => ({}) } as any;
  const mount = (section: string) => renderToString(<ActionContext.Provider value={runner}><TaskContext.Provider value={{ state, api: {} as any }}><SettingsGeneral section={section} initialData={settings} /></TaskContext.Provider></ActionContext.Provider>);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const input = (value: string, checked = false) => ({ currentTarget: { validity: { valid: true }, value, checked } });
  try {
    mount('app');
    handlers.check!(); await settle();
    handlers.autoCheck!(input('', false)); await settle();
    mount('planner');
    handlers.reserve!(input('25')); await settle();
    handlers.threshold!(input('90')); await settle();
  } finally { options.vnode = old; }
  expect(calls).toEqual([
    { op: 'update.check', params: { force: true } },
    { op: 'config.set', params: { key: 'update_check', value: false } },
    { op: 'config.set', params: { key: 'pacing.planner_reserve', value: 25 } },
    { op: 'config.set', params: { key: 'pacing.fill_threshold', value: 90 } },
  ]);
});

test('setting_row_toggles_keep_a_hit_area_and_labelled_controls_keep_their_name', () => {
  const html = renderToString(<SettingRow label="Check for updates" description="Once a day"><Checkbox checked onChange={() => {}} /></SettingRow>);
  const id = attr(html, /<label[^>]*for="([^"]+)"[^>]*>Check for updates<\/label>/);
  expect(html).toMatch(new RegExp(`<label class="pc-checkbox pc-checkbox--bare"><input(?=[^>]*id="${id}")`));
  const own = renderToString(<SettingRow label="Sessions" description="Live sessions"><Checkbox label="Full live sessions" /></SettingRow>);
  expect(own).not.toMatch(/<label[^>]*for=/);
  expect(own).toContain('role="group"');
});

test.skipIf(!browserPath)('setting_row_toggle_hit_area_meets_density', async () => {
  const { DensityContext } = await import('../app/src/ds/Density');
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const css = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css'].map(path => Bun.file(path).text()))).join('\n');
    const markup = renderToString(<DensityContext.Provider value="settings"><SettingRow label="Check for updates" description="Once a day"><Checkbox checked onChange={() => {}} /></SettingRow></DensityContext.Provider>);
    const sizes: { width: number; height: number }[] = [];
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.setContent(`<style>${css}</style>${markup}`);
      sizes.push(await page.locator('.pc-setting-row .pc-checkbox').evaluate(node => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height }; }));
      await page.getByText('Check for updates').click();
      expect(await page.locator('input[type=checkbox]').isChecked()).toBe(false);
      await page.close();
    }
    // Settings density on desktop; touch size when narrow. Width counts as much as height.
    expect(sizes[0]!.width).toBeGreaterThanOrEqual(32); expect(sizes[0]!.height).toBeGreaterThanOrEqual(32);
    expect(sizes[1]!.width).toBeGreaterThanOrEqual(48); expect(sizes[1]!.height).toBeGreaterThanOrEqual(48);
  } finally { await browser.close(); }
}, 20_000);
