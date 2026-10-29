import { executorLabel } from "../src/view-model/words";
import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { renderToString } from 'preact-render-to-string';
import { SettingRow } from '../app/src/ds/SettingRow';
import { SettingsNav } from '../app/src/ds/SettingsNav';
import { Checkbox, Switch, TextInput } from '../app/src/ds/Controls';
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
    '#/', '#/settings', '#/settings/executors', '#/settings/dispatcher', '#/settings/planner', '#/settings/machine',
    '#/settings/plugins', '#/settings/app', '#/settings/diagnostics',
  ]);
  expect(html).not.toMatch(/tabindex="[1-9]/);
  expect(html.indexOf('>Dispatch<')).toBeLessThan(html.indexOf('>Extend<'));
  expect(html.indexOf('>Extend<')).toBeLessThan(html.indexOf('>App<'));
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
    for (const heading of ['Updates', 'Notifications', 'Look']) expect(html).toMatch(new RegExp(`<h2[^>]*>${heading}</h2>`));
    expect(html).toContain('id="updates"');
    expect(html).toContain('id="notifications"');
    expect(html).toContain('id="appearance"');
    expect(html).toContain('aria-label="Notify me about"');
    expect(html).not.toContain('Pacing policy');
    expect(html).not.toContain('Run checks');
  }
});

test('Overview treats a busy executor as able to take work', () => {
  const eligible = {state:'eligible',reasons:[],evaluatedAt:1000,evidenceAgeS:0,budget:'permitted'};
  const busy = { ...executor, id: 'busy', state: 'busy', eligibility:eligible };
  const html = render(<SettingsGeneral initialData={settings} />, { ...state, snapshot: { ...state.snapshot, executors: [{...executor,eligibility:eligible}, busy], machine: { used: 0, max: 4 } } });
  expect(html).toContain('2 of 2 agents can take work. 0 need you.');
  expect(html).not.toContain('busy cannot take work');
});

test('Overview shows only real readiness and setup facts', () => {
  const eligible = {state:'eligible',reasons:[],evaluatedAt:1000,evidenceAgeS:0,budget:'permitted'};
  const down = { ...executor, state: 'down', eligibility:{...eligible,state:'ineligible',reasons:[{code:'subscription_missing'}]} };
  const stale = { ...executor, id: 'stale', stale: true };
  const html = render(<SettingsGeneral initialData={settings} />, { ...state, snapshot: { ...state.snapshot, executors: [{...executor,eligibility:eligible}, down, stale], machine: { used: 0, max: 4 } } });
  expect(html).toContain('1 of 3 agents can take work. 2 need you.');
  for (const title of ['Readiness', 'Current setup']) expect(html).toMatch(new RegExp(`<h2[^>]*>${title}</h2>`));
  for (const href of ['executors', 'dispatcher', 'planner', 'machine']) expect(html).toContain(`href="#/settings/${href}"`);
  expect(html).toContain('No active subscription');
  expect(html).toContain('Usage reading needs refreshing');
  expect(html).toContain('Saved setup default');
  expect(html).not.toContain('Diagnostics not run');
  expect(html).not.toContain('Planner connected');
});

test('Budget & pacing and App preferences rows use the shared SettingRow grammar', () => {
  const budget = render(<SettingsGeneral section="planner" initialData={settings} />);
  expect((budget.match(/class="pc-setting-row pc-setting-row--board pc-setting-row--budget"/g) ?? []).length).toBe(5);
  expect(budget).not.toContain('class="u3-setting"');
  const app = render(<SettingsGeneral section="app" initialData={settings} />);
  expect((app.match(/class="pc-setting-row(?: pc-setting-row--board)?"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  expect(app).toContain('class="pc-checkbox pc-checkbox--bare"');
  const diagnostics = render(<SettingsGeneral section="diagnostics" />);
  expect(diagnostics).toContain('class="pc-diagnostics-header"');
  // The issue count appears once, in the results summary, never in the row.
  expect(diagnostics).not.toContain('pc-pill');
  expect(diagnostics).not.toContain('next routing decision');
  expect(budget).toContain('Changes apply to the next decision.');
  expect(app).not.toContain('next routing decision');
  expect(diagnostics).toContain('Run all checks');
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
    mount('accounts');
    handlers.get('Multiple accounts')!('fill');
    await settle();
    mount('app');
    for (const level of ['important', 'off', 'all']) {
      handlers.get('Notify me about')!(level);
      await settle();
    }
  } finally { options.vnode = old; }
  expect(calls).toEqual([
    { op: 'config.set', params: { key: 'pacing.policy', value: 'even' } },
    { op: 'config.set', params: { key: 'pacing.accounts', value: 'fill' } },
    { op: 'notifications.set', params: { level: 'important' } },
    { op: 'notifications.set', params: { level: 'off' } },
    { op: 'notifications.set', params: { level: 'all' } },
  ]);
});

const browserPath = process.env.PACER_TEST_BROWSER;
test.skipIf(!browserPath)('settings_nav_tab_order_follows_groups', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    const css = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css'].map(path => Bun.file(path).text()))).join('\n');
    await page.setContent(`<style>${css}</style>${renderToString(<SettingsPanel route={{ name: 'settings', section: 'planner', query }} counts={null} />)}`);
    const order: string[] = [], expected = navOrder(await page.content());
    for (let i = 0; i < expected.length; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement?.getAttribute('href') ?? '')); }
    expect(order).toEqual(expected);
    expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('solid');
    expect(await page.locator('[aria-current="page"]').getAttribute('href')).toBe('#/settings/planner');
    expect(await page.getByRole('navigation', { name: 'Settings' }).ariaSnapshot()).toContain('Budget & pacing');
  } finally { await browser.close(); }
}, 20_000);

test('the floating update notice stays hidden on every App preferences route only', () => {
  for (const section of ['app', 'updates', 'notifications', 'appearance']) expect(updateNoticeHiddenOn({ name: 'settings', section })).toBe(true);
  for (const route of [{ name: 'settings' }, { name: 'settings', section: 'planner' }, { name: 'settings', section: 'diagnostics' }, { name: 'overview' }, { name: 'hosts' }]) expect(updateNoticeHiddenOn(route)).toBe(false);
});

test('menu shows Agents attention and Overview shows executor facts', () => {
  const snapshot = { ...state.snapshot, executors: [{ ...executor, state: 'blocked' }], hosts: [{ alias: 'devbox', state: 'needs_setup' }], accounts: [{}, {}] };
  const menu = renderToString(<SettingsPanel route={{ name: 'settings', query }} counts={null} snapshot={snapshot} />);
  const overview = render(<SettingsGeneral initialData={settings} />, { ...state, snapshot });
  expect(menu).toContain('1 blocked');
  expect(menu).not.toContain('1 needs setup');
  expect(overview).toContain('Cannot take work');
  expect(overview).not.toContain('Diagnostics not run');
  expect(menu).not.toContain('2 accounts');
  // Removed account counts do not appear in either destination catalog.
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
    if (props?.['aria-label'] === 'Check automatically' && 'checked' in props && props.onChange) handlers.autoCheck = props.onChange;
    if (props?.['aria-label'] === 'Keep back for planning and review' && props.onChange) handlers.reserve = props.onChange;
    if (props?.type === 'number' && props.max === '100' && props.onChange) handlers.threshold = props.onChange;
  };
  const calls: unknown[] = [];
  const runner = { run: async (_key: string, request: any) => { calls.push({ op: request.op, params: request.params }); return { status: 'done' }; }, result: () => ({}) } as any;
  const mount = (section: string) => renderToString(<ActionContext.Provider value={runner}><TaskContext.Provider value={{ state, api: {} as any }}><SettingsGeneral section={section} initialData={{ ...settings, config: { ...settings.config, keys: { ...settings.config.keys, 'pacing.accounts': { value: 'fill' }, 'pacing.fill_threshold': { value: 80 } } } }} /></TaskContext.Provider></ActionContext.Provider>);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const input = (value: string, checked = false) => ({ currentTarget: { validity: { valid: true }, value, checked } });
  try {
    mount('app');
    handlers.check!(); await settle();
    handlers.autoCheck!(input('', false)); await settle();
    mount('planner');
    handlers.reserve!(input('25')); await settle();
    mount('accounts');
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


test('secondary settings routes select their parent category and retain page titles', () => {
  for (const [hash, current, title] of [
    ['#/settings/accounts', 'executors', 'Accounts'],
    ['#/settings/add-executor', 'executors', 'Add an agent'],
    ['#/settings/hosts', 'machine', 'Machines'],
    ['#/settings/hosts/devbox', 'machine', 'Host'],
    ['#/settings/executors', 'executors', 'Agents'],
    ['#/settings/machine', 'machine', 'Machines'],
  ]) {
    const route = resolveRoute(hash!) as Route;
    const html = renderToString(<SettingsPanel route={route} counts={null} />);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`<a(?=[^>]*href="#/settings/${current}")(?=[^>]*aria-current="page")`));
    expect(titleFor(route)).toBe(title!);
  }
});

test('board navigation includes its back link and save guidance without unsupported badges', () => {
  const html = renderToString(<SettingsPanel route={{ name: 'settings', query }} counts={null} />);
  expect(html).toMatch(/<a(?=[^>]*href="#\/")(?=[^>]*aria-label="Back to Dispatch")/);
  expect(html).toContain('Nothing saves silently');
  expect(html).toContain('Lists and editors show unsaved changes until you save. Switches save at once.');
  for (const label of ['Agents', 'Machines', 'Settings']) expect(html).toContain(`>${label}<`);
  for (const text of ['>Accounts<', '>Add executor<', '>Remote hosts<', 'Checks not run']) expect(html).not.toContain(text);
});

test('Agents retain links to secondary pages with the current scope', () => {
  const scoped = { repo: '', scope: 'repo:example' };
  const agents = render(<SettingsGeneral section="executors" query={scoped} />);
  for (const page of ['accounts', 'add-executor']) expect(agents).toContain(`href="#/settings/${page}?repo=&amp;scope=repo%3Aexample"`);
});

test.skipIf(!browserPath)('settings navigation matches board geometry in its panel and remains a narrow strip', async () => {
  const { SidePanel } = await import('../app/src/ds/SidePanel');
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const css = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/styles.css'].map(path => Bun.file(path).text()))).join('\n');
    const snapshot = { ...state.snapshot, executors: [{ ...executor, state: 'blocked' }] };
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const nav = <SettingsPanel route={{ name: 'settings', query }} counts={null} snapshot={snapshot} embedded />;
      await page.setContent(`<html data-theme="${theme}"><style>${css}</style>${renderToString(<SidePanel side="left" label="Settings" open onToggle={() => {}}>{nav}</SidePanel>)}</html>`);
      expect(await page.locator('.pc-side-panel').evaluate(node => node.getBoundingClientRect().width)).toBe(240);
      const styles = await page.locator('.pc-settings-nav').evaluate(node => {
        const nav = getComputedStyle(node), item = getComputedStyle(node.querySelector('.pc-settings-nav__item')!), heading = getComputedStyle(node.querySelector('.pc-settings-nav__heading')!), badge = getComputedStyle(node.querySelector('.pc-settings-nav__badge')!);
        return { padding: nav.padding, gap: nav.gap, height: item.height, radius: item.borderRadius, itemGap: item.gap, weight: item.fontWeight, headingSize: heading.fontSize, headingLine: heading.lineHeight, tracking: heading.letterSpacing, badgePadding: badge.padding, badgeWeight: badge.fontWeight };
      });
      expect(styles).toEqual({ padding: '14px 10px', gap: '2px', height: '34px', radius: '8px', itemGap: '10px', weight: '600', headingSize: '11px', headingLine: '14px', tracking: '0.66px', badgePadding: '0px 7px', badgeWeight: '650' });
      // The retained SidePanel toggle must not cover the board back link.
      await page.getByRole('link', { name: 'Back to Dispatch' }).click({ trial: true });
      await page.getByRole('button', { name: 'Hide Settings' }).click({ trial: true });
      await page.close();
    }
    const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
    await page.setContent(`<style>${css}</style>${renderToString(<div className="pc-app pc-app--narrow"><SettingsPanel route={{ name: 'settings', section: 'diagnostics', query }} counts={null} /></div>)}`);
    expect(await page.locator('.pc-settings-nav__header').isVisible()).toBe(false);
    expect(await page.locator('.pc-settings-nav__footer').isVisible()).toBe(false);
    expect(await page.locator('.pc-settings-nav').evaluate(node => getComputedStyle(node).flexDirection)).toBe('row');
    expect(await page.locator('.pc-settings-nav__item').first().evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(48);
    await page.getByRole('link', { name: 'Diagnostics' }).focus();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await browser.close(); }
}, 20_000);

test('App board omits unsupported controls and only offers backed terminal choices', async () => {
  const html = render(<SettingsGeneral section="app" initialData={settings}/>);
  for (const absent of ['Desktop banners', '>Plugins<', 'Last checked']) expect(html).not.toContain(absent);
  for (const label of ['Compact', 'Comfortable', 'Nothing', 'Important', 'Everything', 'Check automatically']) expect(html).toContain(label);
  expect(html).toMatch(/<input(?=[^>]*role="switch")(?=[^>]*aria-checked="true")/);
  expect(html).toContain('Release notes');
  expect(html).not.toContain('aria-label="Terminal"');
});

test.skipIf(!browserPath)('Overview and App board geometry, themes and narrow containment', async () => {
  const browser = await chromium.launch({executablePath:browserPath!,headless:true});
  try {
    const css = (await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css','app/src/screens/settings/settings.css'].map(path=>Bun.file(path).text()))).join('\n');
    const { mkdir } = await import('node:fs/promises');
    await mkdir('.work/reviews/settings-overview-app', {recursive:true});
    for (const section of ['', 'app']) for (const theme of ['light','dark']) for (const width of [1440,375]) {
      const page = await browser.newPage({viewport:{width,height:900}});
      const snapshot = {...state.snapshot,executors:[executor,{...executor,id:'blocked',state:'blocked',reason:'No subscription',tone:'bad'}],machine:{used:0,max:4}};
      const configured = { ...settings, config: { ...settings.config, keys: { ...settings.config.keys, "terminal.open": {value:"ghostty"} }, terminalChoices: [{value:"ghostty",label:"Ghostty"},{value:"auto",label:"Automatic"}] } };
      const html = render(<SettingsGeneral section={section} initialData={configured}/>,{...state,snapshot});
      await page.setContent(`<html data-theme="${theme}"><style>${css}</style>${html}</html>`);
      const geometry = await page.locator('.pc-page').evaluate(node=>{
        const canvas=getComputedStyle(node),board=getComputedStyle(node.querySelector('.pc-settings-board')!),h=getComputedStyle(node.querySelector('h1')!);
        return {padding:canvas.padding,maxWidth:canvas.maxWidth,gap:board.gap,title:[h.fontSize,h.lineHeight,h.fontWeight]};
      });
      expect(geometry).toEqual({padding:width===1440?'24px 32px 40px':'16px',maxWidth:'none',gap:section?'24px':'20px',title:['28px','34px','650']});
      if(section && width===1440) {
        expect(await page.locator('.pc-setting-row--board').first().evaluate(node=>{
          const s=getComputedStyle(node);return {columns:s.gridTemplateColumns,gap:s.gap,padding:s.padding,border:s.borderTopWidth};
        })).toEqual({columns:'300px 1052px',gap:'24px',padding:'14px 0px',border:'1px'});
        expect(await page.locator('.pc-segmented--board button').first().evaluate(node=>node.getBoundingClientRect().height)).toBe(30);
        expect(await page.getByRole('switch',{name:'Check automatically',exact:true}).evaluate(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,thumb:getComputedStyle(node,'::before').width}))).toEqual({width:36,height:20,thumb:'16px'});
      }
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:`.work/reviews/settings-overview-app/${section||'overview'}-${theme}-${width}.png`,fullPage:true});
      await page.close();
    }
  } finally {await browser.close();}
},30_000);


test.skipIf(!browserPath)('small settings Switch keeps native keyboard, label and focus behavior', async () => {
  const browser = await chromium.launch({executablePath:browserPath!,headless:true});
  try {
    const page = await browser.newPage();
    const css = (await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css'].map(path=>Bun.file(path).text()))).join('\n');
    const html = renderToString(<SettingRow variant="board" label="Check automatically" description="Once a day"><Switch size="sm" checked/></SettingRow>);
    await page.setContent(`<style>${css}</style>${html}`);
    const control = page.getByRole('switch', {name:'Check automatically'});
    expect(await control.getAttribute('aria-checked')).toBe('true');
    await control.focus();
    expect(await control.evaluate(node=>getComputedStyle(node).outlineStyle)).toBe('solid');
    await page.keyboard.press('Space');
    expect(await control.isChecked()).toBe(false);
    await page.getByText('Check automatically',{exact:true}).click();
    expect(await control.isChecked()).toBe(true);
    expect(await control.evaluate(node=>getComputedStyle(node).justifyContent)).toBe('flex-start');
  } finally {await browser.close();}
},20_000);


test('Budget board uses real planner facts and omits unsupported controls', () => {
  const planner = { agent: 'codex', runner: 'codex#team', usedPct: 18, pacePct: 38, deltaPts: -20, verdict: 'behind', window: 'weekly', resetsAt: 1800000000, stale: false, mode: 'relaxed', advice: '20 pts under pace — spend it.' };
  const html = render(<SettingsGeneral section="planner" initialData={settings} />, { ...state, snapshot: { ...state.snapshot, planner } });
  expect(html).toContain('pc-settings-board--budget');
  expect(html.match(/<h3 /g)).toHaveLength(5);
  expect(html).toContain('Codex is 20 points under pace, so it may do small edits itself.');
  expect(html).toContain('Emergency, Strict, Normal, Relaxed; Relaxed is active');
  expect(html).toContain('18% of weekly used · pace 38% · 20% kept for planning and review');
  expect(html).toContain('Hold strict');
  expect(html).toContain('Hold relaxed');
  for (const label of ['points ahead', 'From 6 hours', 'When an executor runs out', 'Pace team weekly']) expect(html).not.toContain(label);
  const reserveId = attr(html, /<label[^>]*for="([^"]+)"[^>]*>Keep back for planning and review<\/label>/);
  expect(reserveId).toBeTruthy();
  expect(html).toMatch(new RegExp(`<input(?=[^>]*id="${reserveId}")(?=[^>]*type="range")`));
});

test('Budget windows show every reported window without inventing pace or resets', () => {
  const accounts = [{ name: 'team', kind: 'codex', usageReading: { windows: [{ name: 'weekly', usedPct: 18, resetsAt: 1800000000 }, { name: '5h', usedPct: 4, resetsAt: null }] } }];
  const html = render(<SettingsGeneral section="planner" initialData={{ ...settings, accounts }} />);
  expect(html.match(/pc-budget-window"/g)).toHaveLength(2);
  expect(html).toContain('team weekly usage');
  expect(html).toContain('team 5h usage');
  expect(html).not.toContain('role="switch"');
  expect(html).not.toContain('pace 38%');
});

test('Budget mode choices preserve service operation parameters', async () => {
  const { options } = await import('preact');
  let change: (value: string) => void = () => { throw Error('Mode missing'); };
  const old = options.vnode;
  options.vnode = node => { old?.(node); const p = node.props as any; if (p.label === 'Mode' && p.onChange) change = p.onChange; };
  const calls: unknown[] = [];
  const runner = { run: async (_: string, r: any) => { calls.push({ op: r.op, params: r.params }); return { status: 'done' }; }, result: () => ({}) } as any;
  try {
    renderToString(<ActionContext.Provider value={runner}><TaskContext.Provider value={{ state, api: {} as any }}><SettingsGeneral section="planner" initialData={settings} /></TaskContext.Provider></ActionContext.Provider>);
    for (const value of ['strict', 'relaxed', 'auto']) { change(value); await new Promise(resolve => setTimeout(resolve, 0)); }
  } finally { options.vnode = old; }
  expect(calls).toEqual([{ op: 'mode.hold', params: { mode: 'strict' } }, { op: 'mode.hold', params: { mode: 'relaxed' } }, { op: 'mode.release', params: {} }]);
});

test.skipIf(!browserPath)('Budget board geometry matches tokens in both themes and contains narrow content', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const css = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/styles.css', 'app/src/screens/settings/settings.css'].map(path => Bun.file(path).text()))).join('\n');
    const { mkdir } = await import('node:fs/promises');
    await mkdir('.work/reviews/settings-budget', { recursive: true });
    const planner = { agent: 'codex', runner: 'codex#team', usedPct: 18, pacePct: 38, deltaPts: -20, verdict: 'behind', window: 'weekly', resetsAt: 1800000000, stale: false, mode: 'relaxed' };
    const accounts = [{ name: 'team', kind: 'codex', usageReading: { windows: [{ name: 'weekly', usedPct: 18, resetsAt: 1800000000 }, { name: '5h', usedPct: 4, resetsAt: null }] } }];
    for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const html = render(<SettingsGeneral section="planner" initialData={{ ...settings, accounts }} />, { ...state, snapshot: { ...state.snapshot, planner } });
      await page.setContent(`<html data-theme="${theme}"><style>${css}</style>${html}</html>`);
      expect(await page.locator('.pc-page').evaluate(node => {
        const s = getComputedStyle(node), b = getComputedStyle(node.querySelector('.pc-settings-board')!);
        return { padding: s.padding, maxWidth: s.maxWidth, gap: b.gap };
      })).toEqual({ padding: width === 1440 ? '24px 32px 40px' : '16px', maxWidth: 'none', gap: '18px' });
      expect(await page.locator('.pc-setting-row__label').first().evaluate(node => {
        const s = getComputedStyle(node); return [s.fontSize, s.lineHeight, s.fontWeight];
      })).toEqual(['14px', '20px', '650']);
      if (width === 1440) {
        expect(await page.locator('.pc-setting-row').first().evaluate(node => {
          const s = getComputedStyle(node); return { columns: s.gridTemplateColumns, gap: s.gap, padding: s.padding, align: s.alignItems };
        })).toEqual({ columns: '300px 1052px', gap: '24px', padding: '16px 0px', align: 'start' });
        expect(await page.getByRole('button', { name: 'Review integration changes', exact: true }).evaluate(node => node.getBoundingClientRect().height)).toBe(32);
        expect(await page.locator('.pc-budget-mode__fill').first().evaluate(node => node.getBoundingClientRect().height)).toBe(6);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.work/reviews/settings-budget/budget-${theme}-${width}.png`, fullPage: true });
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

test('Budget planner selection retains the configured choices and consent review entry', async () => {
  const { options } = await import('preact');
  let choice: any;
  const old = options.vnode;
  options.vnode = node => {
    old?.(node); const p = node.props as any;
    if (p['aria-label'] === 'Planner' && p.onValueChange) choice = p;
  };
  try {
    const html = render(<SettingsGeneral section="planner" initialData={settings} />);
    expect(choice.value).toBe('codex#team');
    expect(choice.options).toEqual(settings.config.planners.map(value => ({ value, label: executorLabel(value) })));
    expect(html).toContain('Review integration changes');
    expect(html).not.toContain('Planner integration changes');
  } finally { options.vnode = old; }
});

test('Budget planner modes and held state use snapshot facts, with honest unknown and stale readings', () => {
  for (const mode of ['strict', 'normal', 'relaxed', 'emergency']) {
    const planner = { agent: 'codex', runner: 'codex#team', usedPct: null, pacePct: null, deltaPts: null, mode, modeHeldUntil: 1800000000, advice: 'No usage reading for the planner yet.' };
    const html = render(<SettingsGeneral section="planner" initialData={settings} />, { ...state, snapshot: { ...state.snapshot, planner } });
    expect(html).toContain(`pc-budget-mode--${mode} pc-budget-mode--active`);
    expect(html).toContain('No usage reading for the planner yet.');
    expect(html).not.toContain('points under');
    expect(html).not.toContain('of weekly used');
    expect(html).toContain('held until');
  }
  const html = render(<SettingsGeneral section="planner" initialData={settings} />, { ...state, snapshot: { ...state.snapshot, planner: { agent: 'codex', mode: 'relaxed', usedPct: 18, pacePct: 38, stale: true } } });
  expect(html).toContain('Codex has a stale usage reading.');
  expect(html).not.toContain('so it may do small edits itself');
});

test('Budget windows use pace only on matching windows and preserve individual freshness', () => {
  const accounts = [{ name: 'team', kind: 'codex', usageReading: { stale: true, windows: [{ name: 'weekly', usedPct: 18, resetsAt: null, stale: false }, { name: '5h', usedPct: 4, resetsAt: null, stale: true }] } }];
  const binding = { name: 'team', agent: 'codex', window: 'weekly', usedPct: 18, pacePct: 38, verdict: 'BEHIND', stale: false };
  const html = render(<SettingsGeneral section="planner" initialData={{ ...settings, accounts }} />, { ...state, snapshot: { ...state.snapshot, accounts: [binding] } });
  expect(html.match(/pc-meter__pace/g)).toHaveLength(1);
  expect(html.match(/pc-meter--stale/g)).toHaveLength(1);
  expect(html).toContain('18% · pace 38%');
  expect(html).toContain('>Stale</span>');
});
