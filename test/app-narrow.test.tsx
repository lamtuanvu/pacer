import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { initialState } from "../app/src/data/store";
import { createActionRunner } from "../app/src/data/actions";
import { activeRepo, NARROW_MEDIA, PANEL_MEDIA } from "../app/src/shell/narrow";
import { inheritQuery, resolveRoute, type Route, type RouteQuery } from "../app/src/router";
import { Layout } from "../app/src/shell/Layout";
import { OverviewView } from "../app/src/screens/Overview";
import { RepoFilter } from "../app/src/screens/RepoFilter";
import { Button } from "../app/src/ds/Button";

const snapshot = fixture as unknown as ClientSnapshot;
const repo = "github.com/acme/api";
const state = { ...initialState(), snapshot, connected: true, features: { ...initialState().features, readModel: true } };
const runner = createActionRunner({ call: async <T,>() => ({} as T), waitFor: async () => true, refetch: () => {}, navigate: () => {} });
const route = (hash: string) => resolveRoute(hash) as Route;
function atWidth<T>(width: number, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  // The shell asks only for its narrow breakpoint and the side-panel width.
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: (query: string) => {
    expect([NARROW_MEDIA, PANEL_MEDIA]).toContain(query);
    return { matches: query === NARROW_MEDIA ? width < 560 : width >= 768 };
  } } });
  try { return run(); } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
const shell = (hash: string, title = "Overview") => renderToString(<Layout route={route(hash)} state={state} title={title}><Button size="sm">Action</Button></Layout>);
const overview = (query: RouteQuery) => renderToString(<OverviewView snapshot={snapshot} query={query} now={snapshot.at} runner={runner} activity={[]} ops={new Set()} />);

test("shell switches below 560 px and repo scope forces narrow at desktop width", () => {
  for (const [width, hash, narrow] of [[400, "#/", true], [559, "#/", true], [560, "#/", false], [1200, "#/", false], [1200, `#/?scope=repo:${repo}`, true], [1200, "#/?scope=all", false]] as const) {
    const html = atWidth(width, () => shell(hash));
    expect(html.includes('class="pc-bottom-bar"')).toBe(narrow);
    expect(html.includes('class="pc-rail"')).toBe(!narrow);
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.includes("pc-app--narrow")).toBe(narrow);
    expect(html.includes("pc-btn--touch")).toBe(narrow);
  }
});

test("bottom bar keeps all four icons, badges and scope on every destination", () => {
  for (const screen of ["/", "/needs-you", "/tasks", "/settings", "/settings/hosts", "/settings/add-executor"]) {
    const html = atWidth(400, () => shell(`#${screen}?scope=repo:${repo}`, screen));
    expect(html).toContain('class="pc-bottom-bar"');
    expect(html).not.toContain('class="pc-rail"');
    expect(html).toContain('aria-label="Overview"');
    expect(html).toContain('aria-label="Needs you, 4 items"');
    expect(html).toContain('aria-label="Tasks, 2 running"');
    expect(html).toContain(`href="#/settings?scope=repo%3Agithub.com%2Facme%2Fapi"`);
    expect(html).toContain("pc-planner");
    expect(html).toContain("63%·77");
    expect(html).toMatch(/pc-btn--touch[^>]*>Delegate</);
  }
  const html = atWidth(400, () => renderToString(<Layout route={route("#/")} state={{ ...state, snapshot: { ...snapshot, counts: { ...snapshot.counts!, setupOpen: 1 } } }} title="Overview">body</Layout>));
  expect(html).toContain('pc-rail__dot');
});

test("narrow Overview uses Panel order, repo default, other-repo count and compact capacity", () => {
  const html = atWidth(1200, () => overview({ repo: "another", scope: `repo:${repo}` }));
  const sections = ['aria-label="Scope"', '>Needs you<', '>Running<', '>Capacity<', '>Done today<'].map(s => html.indexOf(s));
  expect(sections.every(at => at >= 0)).toBe(true);
  expect(sections).toEqual([...sections].sort((a, b) => a - b));
  expect(html).toMatch(/aria-pressed="true"[^>]*>This repo · acme\/api/);
  expect(html).toContain('+1 in other repos');
  expect(html).not.toContain('Add dark mode to the web header');
  expect(html).toContain('LM Studio is not running');
  expect(html).toContain('pc-capacity--compact');
  expect(html).toContain('pc-cap__dot--neutral');
  expect(html).toContain('Eligibility unknown');
  expect(html).toContain('2 ready · 2 down');
  expect(html).toContain('next: <b>Codex · team on devbox</b>');
  expect(html).not.toContain('pc-planner-strip');
  expect(html).not.toContain('>Activity<');
  expect(html).not.toContain('>Quick delegate<');
  expect(html).toMatch(/pc-btn--touch[^>]*>Retry on Codex</);
});

test("width-only narrow uses the repo filter, otherwise All; explicit All keeps repo scope", () => {
  const html = atWidth(400, () => overview({ repo, scope: null }));
  expect(html).toMatch(/aria-pressed="true"[^>]*>This repo · acme\/api/);
  const all = atWidth(400, () => overview({ repo: null, scope: null }));
  expect(all).toMatch(/aria-pressed="true"[^>]*>All repos/);
  expect(all).not.toContain('in other repos');
  const scopedAll = atWidth(1200, () => overview({ repo: "", scope: `repo:${repo}` }));
  expect(scopedAll).toMatch(/aria-pressed="true"[^>]*>All repos/);
  expect(scopedAll).toContain('Add dark mode to the web header');
  expect(scopedAll).not.toContain('in other repos');
  expect(activeRepo({ repo: null, scope: `repo:${repo}` })).toBe(repo);
});

test("navigation inherits scope and repo without overriding an explicit All selection", () => {
  const current = `#/?repo=${repo}&scope=repo:${repo}`;
  const next = inheritQuery("#/settings/add-executor?host=devbox", current);
  expect(route(next)).toMatchObject({ name: "add-executor", host: "devbox", query: { repo, scope: `repo:${repo}` } });
  const all = inheritQuery("#/?repo=", current);
  expect(route(all).query).toEqual({ repo: "", scope: `repo:${repo}` });
  expect(route(inheritQuery("#/tasks/t1", all)).query).toEqual(route(all).query);
  expect(inheritQuery("https://example.com", current)).toBe("https://example.com");
  expect(inheritQuery("#main-content", current)).toBe("#main-content");
});

test("scope toggle has exactly two 44px controls", async () => {
  const html = renderToString(<RepoFilter snapshot={snapshot} query={{ repo: null, scope: `repo:${repo}` }} narrow />);
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html.match(/pc-btn--touch/g)).toHaveLength(2);
  const css = await Bun.file(new URL('../app/src/ds/components.css', import.meta.url)).text();
  expect(css).toMatch(/\.pc-btn--touch\{min-height:var\(--control-touch\)/);
});

test("narrow Overview stretches every section, including compact Capacity, across the column", async () => {
  const html = atWidth(400, () => overview({ repo: null, scope: `repo:${repo}` }));
  expect(html).toContain('pc-overview--narrow');
  for (const id of ['needs-you', 'running', 'capacity', 'done-today']) {
    expect(html).toContain(`aria-labelledby="${id}"`);
  }
  const css = await Bun.file(new URL('../app/src/styles.css', import.meta.url)).text();
  // Overrides Capacity's desktop align-self:start even when scope forces narrow above 560px.
  expect(css).toMatch(/\.pc-overview--narrow \.pc-overview__main>section\[aria-labelledby\]\s*\{[^}]*align-self:stretch/);
});

test("narrow repo scope shows its own Done today totals", () => {
  for (const width of [400, 1200]) {
    const html = atWidth(width, () => overview({ repo: null, scope: `repo:${repo}` }));
    const section = html.slice(html.indexOf('aria-labelledby="done-today"'));
    expect(section).toContain('3 · 0 accepted');
    expect(section).not.toContain('7 · 6 accepted');
  }
});

test("narrow Needs you puts other repos on the right of its header, once", () => {
  const html = atWidth(400, () => overview({ repo: null, scope: `repo:${repo}` }));
  const section = html.slice(html.indexOf('aria-labelledby="needs-you"'));
  const header = section.slice(0, section.indexOf('</div>'));
  expect(header).toContain('+1 in other repos');
  expect(header.indexOf('class="grow"')).toBeLessThan(header.indexOf('+1 in other repos'));
  expect(section.match(/\+1 in other repos/g)).toHaveLength(1);
});

test('display-contents Overview sections constrain intrinsic long titles to the available width', async () => {
  const css = await Bun.file(new URL('../app/src/styles.css', import.meta.url)).text();
  expect(css).toMatch(/\.pc-overview__main>section,\.pc-overview__side>section\s*\{[^}]*min-width:0[^}]*max-width:100%/);
});

test('consumer styles never reduce canonical button and input hit targets', async () => {
  const css = await Bun.file(new URL('../app/src/styles.css', import.meta.url)).text();
  expect(css).not.toMatch(/\.pc-quick input\s*\{[^}]*min-height/);
  expect(css).not.toMatch(/\.pc-setup-row \.pc-btn\s*\{[^}]*min-height/);
  expect(css).not.toMatch(/(?:^|[{}])\s*\.pc-btn\s*\{[^}]*min-height/);
  const ds = await Bun.file(new URL('../app/src/ds/components.css', import.meta.url)).text();
  expect(ds).toMatch(/\.pc-btn\.pc-btn--touch\s*\{[^}]*min-height:var\(--control-touch\)/);
});

test('narrow Settings navigation contains its scrolling intrinsic width', async () => {
  const css = await Bun.file(new URL('../app/src/styles.css', import.meta.url)).text();
  expect(css).toMatch(/\.pc-app--narrow \.pc-panel\s*\{[^}]*width:100%[^}]*max-width:100%[^}]*align-self:stretch/);
});
