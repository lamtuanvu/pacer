import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { initialState } from "../app/src/data/store";
import { createActionRunner } from "../app/src/data/actions";
import { activeRepo, NARROW_MEDIA, PANEL_MEDIA } from "../app/src/shell/narrow";
import { inheritQuery, resolveRoute, type Route, type RouteQuery } from "../app/src/router";
import { Layout } from "../app/src/shell/Layout";
import { DispatchView } from "../app/src/screens/dispatch/Dispatch";
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
    return { matches: query === NARROW_MEDIA ? width <= 560 : width >= 768 };
  } } });
  try { return run(); } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
const shell = (hash: string, title = "Dispatch") => renderToString(<Layout route={route(hash)} state={state} title={title}><Button size="sm">Action</Button></Layout>);
const overview = (query: RouteQuery) => renderToString(<DispatchView snapshot={snapshot} query={query} now={snapshot.at} runner={runner}/>);

test("shell switches at 560 px and repo scope forces narrow at desktop width", () => {
  for (const [width, hash, narrow] of [[400, "#/", true], [559, "#/", true], [560, "#/", true], [561, "#/", false], [1200, "#/", false], [1200, `#/?scope=repo:${repo}`, true], [1200, "#/?scope=all", false]] as const) {
    const html = atWidth(width, () => shell(hash));
    expect(html.includes('class="pc-bottom-bar"')).toBe(narrow);
    expect(html.includes('class="pc-rail"')).toBe(!narrow);
    expect(html.match(/<header/g)).toHaveLength(1);
    // The phone title belongs to the shell; desktop Dispatch owns its page title.
    expect(html.match(/<h1/g) ?? []).toHaveLength(narrow ? 1 : 0);
    expect(html.includes("pc-app--narrow")).toBe(narrow);
    expect(html.includes("pc-btn--touch")).toBe(narrow);
  }
});

test("bottom bar keeps all five destinations, badges and scope on every destination", () => {
  for (const screen of ["/", "/needs-you", "/tasks", "/settings", "/settings/hosts", "/settings/add-executor"]) {
    const html = atWidth(400, () => shell(`#${screen}?scope=repo:${repo}`, screen === "/" ? "Dispatch" : screen));
    expect(html).toContain('class="pc-bottom-bar"');
    expect(html).not.toContain('class="pc-rail"');
    expect(html).toContain('aria-label="Dispatch"');
    expect(html).toContain('aria-label="Needs you, 4 items"');
    expect(html).toContain('aria-label="Tasks"');
    expect(html).toContain(`href="#/settings?scope=repo%3Agithub.com%2Facme%2Fapi"`);
    expect(html).toContain('aria-label="Insights"');
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    expect(nav.match(/<a /g)).toHaveLength(5);
    expect(nav).not.toContain('Tasks, 2 running');
    // Dispatch puts the budget in its body and offers a touch icon in the header.
    if (screen === "/") {
      expect(html).not.toContain('class="pc-planner"');
      expect(html).toContain('aria-label="New task"');
      expect(html).toContain('pc-btn--touch pc-icon-button');
    } else {
      expect(html).toContain('class="pc-planner"');
      expect(html).toMatch(/pc-btn--touch[^>]*>New task</);
    }
  }
  const html = atWidth(400, () => renderToString(<Layout route={route("#/")} state={{ ...state, snapshot: { ...snapshot, counts: { ...snapshot.counts!, setupOpen: 1 } } }} title="Dispatch">body</Layout>));
  expect(html).toContain('pc-rail__dot');
});

test("narrow Dispatch keeps the spec order, repo default, Needs you link and touch actions", () => {
  const html = atWidth(1200, () => overview({ repo: "another", scope: `repo:${repo}` }));
  const sections = ['aria-label="Planner budget"', '>Needs you<', 'id="running-title"'].map(s => html.indexOf(s));
  expect(sections.every(at => at >= 0)).toBe(true);
  expect(sections).toEqual([...sections].sort((a, b) => a - b));
  expect(html).toContain("Add SSH keepalive to remote runs");
  expect(html).not.toContain("Split the settings page into sections");
  expect(html).toContain('All in Needs you');
  expect(html).not.toContain('Add dark mode to the web header');
  expect(html).toContain("pc-narrow-attention--bad");
  expect(html).toContain("/failure");
  expect(html).toContain(">Inspect</span>");
});

test("width-only narrow uses the repo filter, otherwise All; explicit All keeps repo scope", () => {
  const html = atWidth(400, () => overview({ repo, scope: null }));
  expect(html).toContain("Add SSH keepalive to remote runs");
  expect(html).not.toContain("Split the settings page into sections");
  const all = atWidth(400, () => overview({ repo: null, scope: null }));
  expect(all).toContain("Add SSH keepalive to remote runs");
  expect(all).toContain("Split the settings page into sections");
  expect(all).not.toContain('in other repos');
  const scopedAll = atWidth(1200, () => overview({ repo: "", scope: `repo:${repo}` }));
  expect(scopedAll).toContain("Split the settings page into sections");
  expect(scopedAll).toContain("Add SSH keepalive to remote runs");
  expect(scopedAll).not.toContain('Add dark mode to the web header');
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

test("narrow Dispatch stretches every section across the column", async () => {
  const html = atWidth(400, () => overview({ repo: null, scope: `repo:${repo}` }));
  expect(html).toContain('pc-dispatch--narrow');
  for (const marker of ['aria-labelledby="needs-you"', 'aria-labelledby="running-title"', 'aria-label="Planner budget"']) expect(html).toContain(marker);
  const css = await Bun.file(new URL('../app/src/styles.css', import.meta.url)).text();
  // Stretches even when scope forces narrow above 560px.
  expect(css).toMatch(/\.pc-dispatch--narrow>section\s*\{[^}]*align-self:stretch/);
});

test("narrow Dispatch never shows snapshot counts as the period's figures", () => {
  for (const width of [400, 1200]) {
    const html = atWidth(width, () => overview({ repo: null, scope: `repo:${repo}` }));
    expect(html).not.toContain('id="glance"');
    expect(html).not.toContain("pc-kpi");
    expect(html).toContain('aria-label="Planner budget"');
    expect(html).toContain('aria-valuenow="63"');
  }
});

test("narrow Needs you puts All in Needs you on the right of its header, once", () => {
  const html = atWidth(400, () => overview({ repo: null, scope: `repo:${repo}` }));
  const section = html.slice(html.indexOf('aria-labelledby="needs-you"'));
  const header = section.slice(0, section.indexOf('</div>'));
  expect(header).toContain('All in Needs you');
  expect(header.indexOf('class="grow"')).toBeLessThan(header.indexOf('All in Needs you'));
  expect(header.match(/All in Needs you/g)).toHaveLength(1);
  expect(header).not.toContain('in other repos');
});

test('display-contents Dispatch sections constrain intrinsic long titles to the available width', async () => {
  const css = await Bun.file(new URL('../app/src/styles.css', import.meta.url)).text();
  expect(css).toMatch(/\.pc-dispatch>section\s*\{[^}]*min-width:0[^}]*max-width:100%/);
  expect(css).toMatch(/\.pc-dispatch__pair>\*\s*\{[^}]*min-width:0[^}]*max-width:100%/);
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

test("navigation retains Dispatch and Insights and keeps Setup in the desktop rail", () => {
  for (const width of [375, 1200]) {
    for (const setupOpen of [0, 1]) {
      const html = atWidth(width, () => renderToString(<Layout route={route("#/insights")} state={{ ...state, snapshot: { ...snapshot, counts: { ...snapshot.counts!, setupOpen } } }} title="Insights">body</Layout>));
      expect(html.includes('aria-label="Dispatch"')).toBe(true);
      expect(html.includes('aria-label="Insights"')).toBe(true);
      expect(html.includes('aria-label="Setup · needs you"')).toBe(width > 560 && !!setupOpen);
    }
  }
});
