import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { initialState, reduceStore } from "../app/src/data/store";
import { resolveRoute, type Route } from "../app/src/router";
import { Layout } from "../app/src/shell/Layout";
import { AppFrame } from "../app/src/shell/AppFrame";
import { TaskContext } from "../app/src/screens/task-shared";

const snap = fixture as unknown as ClientSnapshot;
const hello = { pacer: "0.3.0", protocol: "2.8.0", ops: ["terminal.create"], events: ["task", "attention", "counts"] };
const ready = () => ({ ...reduceStore(reduceStore(initialState(), { type: "hello", hello }), { type: "snapshot", snapshot: snap }), connected: true });
const at = (hash: string) => resolveRoute(hash) as Route;
const api = { call: async () => ({}), hello: async () => ({}), snapshot: async () => ({}) } as any;
const withService = (hash: string) => renderToString(<TaskContext.Provider value={{ state: ready(), api }}>
  <Layout route={at(hash)} state={ready()} title="Screen"><p>body</p></Layout>
</TaskContext.Provider>);
/** Opening tags with their class or landmark, in document order. */
const outline = (html: string) => [...html.matchAll(/<(div|header|nav|main|footer|aside|section|a)\b([^>]*)>/g)]
  .map(([, tag, attrs]) => `${tag}${attrs!.match(/ class="([^"]*)"/)?.[1] ? `.${attrs!.match(/ class="([^"]*)"/)![1]}` : ""}${/id="main-content"/.test(attrs!) ? "#main-content" : ""}`)
  .filter(item => /^(header|nav|main|footer|aside|section)|pc-app|pc-body|pc-work|pc-live-region|skip-link|pc-dock|pc-side-panel/.test(item));

test("layout_renders_same_landmarks", () => {
  const html = withService("#/");
  // Dispatch mounts its Scope and Inspector around the work area; the dock stays closed.
  expect(outline(html).filter(item => !item.startsWith("section") && !item.startsWith("nav.pc-") || item.startsWith("nav.pc-rail"))).toEqual([
    "div.pc-app pc-app--with-status", "a.pc-text-action skip-link", "header.pc-topbar", "div.pc-live-region", "div.pc-body", "nav.pc-rail",
    "aside.pc-side-panel pc-side-panel--left pc-scope-panel", "div.pc-work-wrap", "div.pc-work", "main.pc-main pc-main--canvas#main-content", "aside.pc-side-panel pc-side-panel--right", "footer.pc-statusbar",
  ]);
  expect(html).toContain('<header');
  expect(html.indexOf('class="pc-live-region"')).toBeLessThan(html.indexOf('class="pc-body"'));
  expect(html).toContain('<main id="main-content" tabindex="-1" class="pc-main pc-main--canvas"><fieldset class="pc-offline-controls">');
  expect(html).toContain('aria-label="Scope"');
  expect(html).toContain('aria-label="Inspector"');
  expect(html).not.toContain("pc-dock");
  expect(html).not.toContain("pc-app--with-dock");
  // The only frame addition is the status-bar dock control, closed by default.
  expect(html).toMatch(/aria-label="Terminal" aria-keyshortcuts="Control\+`" aria-expanded="false"/);
  expect(html).toContain("Ctrl+`</span>");
});

test("settings routes put the settings links in a collapsible left side panel", () => {
  const html = withService("#/settings");
  expect(html).toContain('<aside aria-label="Settings" class="pc-side-panel pc-side-panel--left">');
  expect(html.match(/aria-label="Settings(, [^"]*)?"/g)?.length).toBe(2); // the side panel landmark and the rail link
  expect(html).not.toContain('class="pc-panel"');
  expect(html).toContain('href="#/settings/machine"');
});

test("narrow_layout_has_no_side_panels_or_dock", () => {
  // A repository scope selects the narrow layout, as on a phone.
  const html = withService("#/settings?scope=repo:github.com/acme/api");
  expect(html).toContain("pc-app pc-app--narrow");
  expect(html).not.toContain("pc-side-panel");
  expect(html).toContain('<aside aria-label="Settings" class="pc-panel">');
  expect(html).not.toContain("pc-statusbar");
  expect(html).not.toContain("pc-dock");
  const frame = renderToString(<AppFrame narrow main={<p>body</p>} left={<p>left</p>} right={<p>right</p>} dock={<p>dock</p>} activity={<nav>rail</nav>} top={<header>top</header>} />);
  expect(frame).not.toContain("right");
  expect(frame).not.toContain("dock");
  expect(frame.indexOf("<nav>")).toBeLessThan(frame.indexOf('class="pc-body"'));
  expect(frame.indexOf("<header>")).toBeGreaterThan(frame.indexOf('class="pc-work"'));
  const wide = renderToString(<AppFrame main={<p>body</p>} right={<p>right</p>} dock={<p>dock</p>} />);
  expect(wide).toContain("pc-app--with-dock");
  expect(wide).toContain('<div class="pc-dock"><fieldset class="pc-offline-controls"><p>dock</p></fieldset></div>');
  expect(wide).toContain("<p>right</p></div>");
});

test("dock_not_rendered_on_terminal_route", () => {
  const key = "pacer.panel.dock";
  const store = new Map<string, string>([[key, "1"]]);
  const previous = (globalThis as any).localStorage;
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  try {
    // Saved open: other routes mount the dock, the terminal route never does and offers no dock control.
    expect(withService("#/")).toContain('<div class="pc-dock"><fieldset class="pc-offline-controls"><section id="pc-terminal-dock"');
    const terminal = withService("#/terminal");
    expect(terminal).not.toContain("pc-dock");
    expect(terminal).not.toContain('aria-label="Terminal panel"');
    expect(terminal).toContain('aria-label="Toggle terminal panel (Ctrl+`)"');
    expect(terminal).toContain("This screen has no terminal panel");
    expect(withService("#/setup")).not.toContain("pc-dock");
  } finally { (globalThis as any).localStorage = previous; }
});

test("settings attention counts enabled executors that cannot take work and names the count", async () => {
  const { settingsAttention } = await import("../app/src/shell/Rail");
  const row = (state: string, enabled = true) => ({ id: state, enabled, state });
  const withExecutors = (executors: unknown[]) => ({ ...snap, executors }) as unknown as ClientSnapshot;
  expect(settingsAttention(null)).toBe(0);
  expect(settingsAttention(withExecutors([row("ready"), row("down", false), row("busy")]))).toBe(0);
  expect(settingsAttention(withExecutors([row("down"), row("failing"), row("ready"), row("exhausted", false)]))).toBe(2);
  const render = (executors: unknown[]) => renderToString(<TaskContext.Provider value={{ state: { ...ready(), snapshot: withExecutors(executors) }, api }}>
    <Layout route={at("#/")} state={{ ...ready(), snapshot: withExecutors(executors) }} title="Screen"><p>body</p></Layout></TaskContext.Provider>);
  expect(render([row("down")])).toContain('aria-label="Settings, 1 agent needs attention"');
  expect(render([row("down"), row("blocked")])).toContain('aria-label="Settings, 2 agents need attention"');
  expect(render([row("ready")])).toContain('aria-label="Settings"');
});

test("the planner chip carries the mode pill with a tone from the mode", () => {
  const html = (mode: string) => { const state = ready(); return renderToString(<TaskContext.Provider value={{ state, api }}>
    <Layout route={at("#/")} state={{ ...state, snapshot: { ...snap, mode: { ...snap.mode!, mode } } as ClientSnapshot }} title="Screen"><p>body</p></Layout></TaskContext.Provider>); };
  expect(html("relaxed")).toMatch(/pc-planner[\s\S]*pc-pill--good[^>]*>Relaxed</);
  expect(html("strict")).toMatch(/pc-planner[\s\S]*pc-pill--warn[^>]*>Strict</);
  expect(html("normal")).toMatch(/pc-planner[\s\S]*pc-pill--neutral[^>]*>Normal</);
});


test("only session detail routes retain the shell page heading", () => {
  for (const hash of ["#/tasks", "#/tasks/new"]) {
    expect(withService(hash)).not.toMatch(/<h1\b/);
  }
  for (const hash of ["#/tasks/task-1"]) {
    expect(withService(hash)).toMatch(/<h1\b/);
  }
});
