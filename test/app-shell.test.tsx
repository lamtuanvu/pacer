import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { initialState, reduceStore } from "../app/src/data/store";
import { resolveRoute, type Route } from "../app/src/router";
import { Rail } from "../app/src/shell/Rail";
import { Layout } from "../app/src/shell/Layout";
import { SettingsPanel } from "../app/src/shell/SettingsPanel";
import { CommandHelp } from "../app/src/shell/CommandHelp";
import { createKeyRegistry } from "../app/src/keys/registry";

const snap = fixture as unknown as ClientSnapshot;
const hello = (protocol: string) => ({ pacer: "0.3.0", protocol, ops: [], events: ["task", "attention", "counts"] });
const ready = (protocol = "2.8.0") => ({ ...reduceStore(reduceStore(initialState(), { type: "hello", hello: hello(protocol) }), { type: "snapshot", snapshot: snap }), connected: true });
const at = (hash: string) => resolveRoute(hash) as Route;

test("rail labels carry counts and mark the current screen", () => {
  const html = renderToString(<Rail route={at("#/needs-you")} counts={snap.counts!} />);
  expect(html).toContain('aria-label="Dispatch"');
  expect(html).not.toContain('aria-label="Overview"');
  expect(html).not.toContain('aria-label="Start work"');
  expect(html).toContain('aria-label="Needs you, 4 items"');
  expect(html).toContain('aria-label="Tasks, 2 running"');
  expect(html).toMatch(/aria-current="page"[^>]*aria-label="Needs you|aria-label="Needs you[^"]*"[^>]*aria-current="page"/);
  expect(html).toContain('role="tooltip"');
});

test("rail badges hide without counts or at zero, and the gear shows open setup", () => {
  const none = renderToString(<Rail route={at("#/")} counts={null} />);
  expect(none).not.toContain("pc-rail__badge");
  expect(none).toContain('aria-label="Dispatch"');
  expect(none).toMatch(/aria-current="page"[^>]*aria-label="Dispatch"|aria-label="Dispatch"[^>]*aria-current="page"/);
  const zero = renderToString(<Rail route={at("#/")} counts={{ ...snap.counts!, attention: 0, review: 0, running: 0 }} />);
  expect(zero).not.toContain("pc-rail__badge");
  expect(zero).not.toContain("pc-rail__dot");
  expect(renderToString(<Rail route={at("#/")} counts={{ ...snap.counts!, setupOpen: 2 }} />)).toContain("pc-rail__dot");
});

test("settings panel lists the board destinations", () => {
  const html = renderToString(<SettingsPanel route={at("#/settings")} counts={snap.counts!} />);
  expect(html).toContain("<aside");
  expect(html).toContain('href="#/settings"');
  expect(html).toContain('href="#/settings/machine"');
  expect(html).toContain('href="#/settings/executors"');
  expect(html).toContain("Machines");
  expect(html).not.toContain("1 needs setup");
});

test("layout has landmarks, a skip link, and the settings panel only in settings", () => {
  const html = renderToString(<Layout route={at("#/")} state={ready()} title="Overview"><p>body</p></Layout>);
  expect(html).toContain('href="#main-content"');
  expect(html).toContain("<nav");
  expect(html).toContain("<header");
  expect(html).toContain('<main id="main-content"');
  expect(html).not.toContain("<aside");
  expect(renderToString(<Layout route={at("#/settings")} state={ready()} title="Settings"><p>body</p></Layout>)).toContain("<aside");
});

test("an older service sees an update notice on the new screens, not empty sections", () => {
  const html = renderToString(<Layout route={at("#/")} state={ready("2.0.0")} title="Overview"><p>body</p></Layout>);
  expect(html).toContain("Update pacer to use this view");
  expect(html).not.toContain("<p>body</p>");
  expect(renderToString(<Layout route={at("#/settings")} state={ready("2.0.0")} title="Settings"><p>body</p></Layout>)).toContain("<p>body</p>");
});

test("loading shows section skeletons, never the setup screen", () => {
  const html = renderToString(<Layout route={resolveRoute("#/", null) as Route} state={ready()} title="Overview"><p>body</p></Layout>);
  expect(html).toContain("pc-skeleton");
  expect(html).not.toContain("<p>body</p>");
  expect(html).not.toContain("Setup");
});

test("session ended replaces the app", () => {
  expect(renderToString(<Layout route={at("#/")} state={{ ...ready(), sessionEnded: true }} title="Overview"><p>body</p></Layout>)).toContain("Session ended");
});

test("shortcut help lists registered shortcuts with keys", () => {
  const registry = createKeyRegistry({ controlActive: () => false });
  registry.register({ keys: "g o", label: "Go to Overview", scope: "global", run: () => {} });
  registry.register({ keys: "a", label: "Accept", scope: "review", run: () => {} });
  const html = renderToString(<CommandHelp registry={registry} close={() => {}} />);
  expect(html).toContain('<dialog');
  expect(html).toContain('<kbd class="pc-kbd">g o</kbd>');
  expect(html).toContain("Go to Overview");
  expect(html).toContain("Review");
});

test("settings shows one Dispatcher destination and only the backed Agents badge", () => {
  const html = renderToString(<SettingsPanel route={at('#/settings')} counts={snap.counts!}
    snapshot={{ ...snap, accounts: Array.from({ length: 6 }, () => snap.accounts![0]!), executors: [{ ...snap.executors![0]!, state: 'down' }], hosts: [{ ...snap.hosts![0]!, state: 'needs_setup' }] }} />);
  expect(html).not.toContain('>Accounts<');
  expect(html).toContain('Dispatcher');
  expect(html).not.toContain('>Strategies<');
  expect(html).not.toContain('>Routing<');
  expect(html).toMatch(/pc-settings-nav__badge--bad"[^>]*><span aria-hidden="true">1</);
  expect(html).toContain("1 needs attention");
  expect(html).not.toContain("1 needs setup");
  expect(html).not.toContain('>1 rule</span>');
});

test("retired and unknown hashes select Dispatch in the shell", () => {
  for (const hash of ["#/accounts", "#/missing"]) {
    const html = renderToString(<Layout route={at(hash)} state={ready()} title="Dispatch"><p>Dispatch body</p></Layout>);
    expect(html).toContain("<p>Dispatch body</p>");
    expect(html).toMatch(/aria-current="page"[^>]*aria-label="Dispatch|aria-label="Dispatch[^"]*"[^>]*aria-current="page"/);
    expect(html).not.toContain("<aside");
  }
});

test("detail routes select exactly one primary and at most one settings destination", () => {
 const task = renderToString(<Rail route={at("#/tasks/t1")} counts={snap.counts!}/>);
 expect(task.match(/aria-current="page"/g)).toHaveLength(1);
 expect(task).toMatch(/aria-current="page"[^>]*aria-label="Tasks|aria-label="Tasks[^\"]*"[^>]*aria-current="page"/);
 const hostRoute = at("#/settings/hosts/devbox");
 const shell = renderToString(<><Rail route={hostRoute} counts={snap.counts!}/><SettingsPanel route={hostRoute} counts={snap.counts!}/></>);
 expect(shell.match(/aria-current="page"/g)).toHaveLength(2);
});


test("top bar calls the delegate action New task on every destination that offers it", () => {
  for (const hash of ["#/needs-you", "#/tasks", "#/settings", "#/settings/dispatcher", "#/terminal"]) {
    const html = renderToString(<Layout route={at(hash)} state={ready()} title="Page">body</Layout>);
    expect(html).toMatch(/pc-btn[^>]*>New task<\/button>/);
    expect(html).not.toMatch(/>Delegate<\/button>/);
  }
});

test("Needs you owns exactly one page title, with no hidden duplicate in the top bar", async () => {
  const { NeedsYouPage } = await import("../app/src/screens/dispatch/Dispatch");
  const { TaskContext } = await import("../app/src/screens/task-shared");
  const { ActionContext } = await import("../app/src/data/action-context");
  const { createActionRunner } = await import("../app/src/data/actions");
  const runner = createActionRunner({ call: async <T,>() => ({} as T), waitFor: async () => true, refetch() {}, navigate() {} });
  const state = ready();
  const route = at("#/needs-you");
  const html = renderToString(<ActionContext.Provider value={runner}><TaskContext.Provider value={{ state, api: {} as never }}><Layout route={route} state={state} title="Needs you"><NeedsYouPage query={route.query} /></Layout></TaskContext.Provider></ActionContext.Provider>);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain('<h1>Needs you</h1>');
  expect(html).toContain('pc-needs-you pc-page-body');
});

test('every settings destination has exactly one h1 in the real shell', async () => {
  const { SettingsGeneral } = await import('../app/src/screens/settings/General');
  const { PluginsPage } = await import('../app/src/screens/settings/PluginsPage');
  const { TaskContext } = await import('../app/src/screens/task-shared');
  const { ActionContext } = await import('../app/src/data/action-context');
  const { createActionRunner } = await import('../app/src/data/actions');
  const state = ready(), api = { call: async <T,>() => ({} as T) } as any;
  const runner = createActionRunner({ call: api.call, waitFor: async () => true, refetch() {}, navigate() {} });
  for (const path of ['', '/executors', '/accounts', '/add-executor', '/dispatcher', '/planner', '/machine', '/hosts', '/hosts/devbox', '/app', '/updates', '/notifications', '/appearance', '/assistant', '/diagnostics', '/plugins']) {
    const route = at(`#/settings${path}`);
    const section = route.name === 'settings' ? route.section : route.name === 'hosts' ? 'hosts' : 'add-executor';
    const html = renderToString(<ActionContext.Provider value={runner}><TaskContext.Provider value={{state, api}}>
      <Layout route={route} state={state} title={`Settings${path}`}>
        {section === 'plugins' ? <PluginsPage initialData={{plugins:[]}}/> : <SettingsGeneral section={section} alias={route.name === 'hosts' ? route.alias : undefined} initialData={{accounts:[], config:{keys:{}, planners:[]} as any}}/>}
      </Layout>
    </TaskContext.Provider></ActionContext.Provider>);
    expect({path, headings:(html.match(/<h1\b/g) ?? []).length}).toEqual({path, headings:1});
    expect(html).toContain(`aria-label="Settings${path}"`);
  }
});
