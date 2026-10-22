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
  expect(html).toContain('aria-label="Overview"');
  expect(html).toContain('aria-label="Needs you · 4 need you"');
  expect(html).toContain('aria-label="Tasks · 2 running"');
  expect(html).toMatch(/aria-current="page"[^>]*aria-label="Needs you|aria-label="Needs you[^"]*"[^>]*aria-current="page"/);
  expect(html).toContain('role="tooltip"');
});

test("rail badges hide without counts or at zero, and the gear shows open setup", () => {
  const none = renderToString(<Rail route={at("#/")} counts={null} />);
  expect(none).not.toContain("pc-rail__badge");
  expect(none).toContain('aria-label="Overview"');
  const zero = renderToString(<Rail route={at("#/")} counts={{ ...snap.counts!, attention: 0, review: 0, running: 0 }} />);
  expect(zero).not.toContain("pc-rail__badge");
  expect(zero).not.toContain("pc-rail__dot");
  expect(renderToString(<Rail route={at("#/")} counts={{ ...snap.counts!, setupOpen: 2 }} />)).toContain("pc-rail__dot");
});

test("settings panel lists general, hosts with a problem count, and add executor", () => {
  const html = renderToString(<SettingsPanel route={at("#/settings")} counts={snap.counts!} />);
  expect(html).toContain("<aside");
  expect(html).toContain('href="#/settings"');
  expect(html).toContain('href="#/settings/hosts"');
  expect(html).toContain('href="#/settings/add-executor"');
  expect(html).toContain("Remote hosts");
  expect(html).toMatch(/pc-rail__badge[^>]*>1 needs setup</);
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

test("settings counts are neutral while executor and host status badges use their tones", () => {
  const html = renderToString(<SettingsPanel route={at('#/settings')} counts={snap.counts!}
    snapshot={{ ...snap, accounts: Array.from({ length: 6 }, () => snap.accounts![0]!), executors: [{ ...snap.executors![0]!, state: 'down' }], hosts: [{ ...snap.hosts![0]!, state: 'needs_setup' }] }}
    badges={{ strategies: 6, routing: '1 rule' }} />);
  expect(html).toMatch(/Accounts<span[^>]*class="pc-rail__badge pc-rail__badge--neutral"[^>]*>6</);
  expect(html).toMatch(/Strategies<span[^>]*class="pc-rail__badge pc-rail__badge--neutral"[^>]*>6</);
  expect(html).toMatch(/pc-rail__badge--bad"[^>]*>1</);
  expect(html).toContain("1 need attention; 0 blocked");
  expect(html).toMatch(/pc-rail__badge--warn"[^>]*>1 needs setup</);
  expect(html).toContain('>1 rule</span>');
});

test("retired and unknown hashes select Overview in the shell", () => {
  for (const hash of ["#/accounts", "#/missing"]) {
    const html = renderToString(<Layout route={at(hash)} state={ready()} title="Overview"><p>Overview body</p></Layout>);
    expect(html).toContain("<p>Overview body</p>");
    expect(html).toMatch(/aria-current="page"[^>]*aria-label="Overview|aria-label="Overview[^"]*"[^>]*aria-current="page"/);
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
