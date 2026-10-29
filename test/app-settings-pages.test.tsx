import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { SettingsGeneral } from '../app/src/screens/settings/General';
import { SettingsPanel } from '../app/src/shell/SettingsPanel';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { resolveRoute, type Route } from '../app/src/router';
import { settings } from './fixtures/ui/settings';
const state = { ...initialState(), snapshot: { executors: [], accounts: [], hosts: [], repos: [] } } as any;
const render = (section?: string) => renderToString(<TaskContext.Provider value={{ state, api: {} as any }}><SettingsGeneral section={section} initialData={settings}/></TaskContext.Provider>);

test('a settings route mounts its own controls without unrelated settings', () => {
  const planner = render('planner');
  expect(planner).toContain('Pacing policy');
  expect(planner).not.toContain('Add account');
  expect(planner).not.toContain('Run checks');
  expect(planner).not.toContain('Settings sections');
  const accounts = render('accounts');
  expect(accounts).toContain('Add account');
  expect(accounts).not.toContain('Pacing policy');
  const updates = render('updates');
  expect(updates).toContain('Check automatically');
  expect(updates).not.toContain('Add account');
});

test('General links to settings pages rather than mounting every editor', () => {
  const html = render();
  expect(html).toContain('href="#/settings/planner"');
  expect(html).toContain('href="#/settings/executors"');
  expect(html).not.toContain('Pacing policy');
  expect(html).not.toContain('Check for updates');
});

test('This machine is a reachable settings page with one current icon navigation item', () => {
  const route = resolveRoute('#/settings/machine') as Route;
  expect(route).toMatchObject({ name: 'settings', section: 'machine' });
  expect(render('machine')).toContain('Parallel tasks on this machine');
  expect(render('machine')).toContain('Preferred terminal');
  expect(render('machine')).toContain('Delegated task launch');
  const html = renderToString(<SettingsPanel route={route} counts={null}/>);
  expect(html).toContain('href="#/settings/machine"');
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  const items = [...html.matchAll(/<a\b[^>]*class="[^"]*pc-settings-nav__item[^>]*>[\s\S]*?<\/a>/g)];
  expect(items.length).toBe(8);
  for (const [item] of items) expect(item).toContain('<svg');
});
test('terminal picker shows Linux automatic and an existing custom template', () => {
  const linux={...settings,config:{...settings.config,keys:{...settings.config.keys,'terminal.open':{value:''},'terminal.app':{value:'Terminal'}},terminalChoices:[{value:'auto',label:'Automatic'},{value:'kitty',label:'Kitty'}]}};
  expect(renderToString(<TaskContext.Provider value={{state,api:{} as any}}><SettingsGeneral section="machine" initialData={linux}/></TaskContext.Provider>)).toContain('Automatic');
  const custom={...linux,config:{...linux.config,keys:{...linux.config.keys,'terminal.open':{value:'kitty -e {cmd}'}}}};
  expect(renderToString(<TaskContext.Provider value={{state,api:{} as any}}><SettingsGeneral section="machine" initialData={custom}/></TaskContext.Provider>)).toContain('Custom terminal');
});

test('General page destinations preserve scope in the href for native link actions', () => {
  const html = renderToString(<TaskContext.Provider value={{state, api:{} as any}}><SettingsGeneral query={{repo:'',scope:'repo:example'}} initialData={settings}/></TaskContext.Provider>);
  expect(html).toContain('href="#/settings/planner?repo=&amp;scope=repo%3Aexample"');
});


test('App Workspace includes assistant status and a settings link with or without an account', () => {
  const statuses = [
    { available: true, configured: true, account: 'answers', label: 'Available · answers' },
    { available: false, configured: true, account: 'answers', reason: 'Daily limit reached.', label: 'Unavailable · answers · Daily limit reached.' },
    { available: false, configured: false, reason: 'The assistant is not set up.', label: 'Not configured · The assistant is not set up.' },
  ];
  for (const { label, ...assistant } of statuses) {
    const html = renderToString(<TaskContext.Provider value={{ state, api: {} as any }}><SettingsGeneral section="app" initialData={{ ...settings, assistant }}/></TaskContext.Provider>);
    const workspace = html.match(/<section[^>]*aria-labelledby="workspace-h"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(workspace).toContain('>Assistant<');
    expect(workspace).toContain('pc-setting-row--board');
    expect(workspace).toContain('Open with ⌘J from anywhere. Uses the account chosen in assistant settings.');
    expect(workspace).toContain(label);
    expect(workspace).toMatch(/<a[^>]*href="#\/settings\/assistant"[^>]*>Choose account and limits<\/a>/);
    expect(workspace).not.toContain('role="switch"');
  }
  expect(resolveRoute('#/settings/assistant')).toMatchObject({ name: 'settings', section: 'assistant' });
  const nav = renderToString(<SettingsPanel route={resolveRoute('#/settings/app') as Route} counts={null}/>);
  expect(nav).not.toContain('href="#/settings/assistant"');
});
