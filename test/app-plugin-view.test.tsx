import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { UI_ICONS, UI_ROUTES, type ViewNode } from "../src/plugins/ui-schema";
import { PLUGIN_ICONS } from "../app/src/plugins/icons";
import { ViewDocument, pluginLink } from "../app/src/plugins/ViewDocument";
import { PluginError, confirmPluginAction } from "../app/src/plugins/Activity";
import { PluginContext } from "../app/src/plugins/catalog";
import { Rail } from "../app/src/shell/Rail";
import { hrefFor, primaryFor, resolveRoute, routes, type Route } from "../app/src/router";
import manifest from "../conformance/fixtures/ui/pacer-plugin.json";
import type { SurfaceInfo } from "../src/plugins/registry";
const at = (hash: string) => resolveRoute(hash) as Route;
const surface = { ...manifest.contributes.ui.activity[0]!, plugin: manifest.id, surface: "activity", context: "global", visible: true, state: "ready" } as SurfaceInfo;
const rail = (surfaces: SurfaceInfo[], narrow = false) => renderToString(<PluginContext.Provider value={{ surfaces, revision: 0 }}><Rail route={at(hrefFor(routes.plugin(surface.plugin, surface.id)))} counts={null} narrow={narrow} /></PluginContext.Provider>);

test("plugin route round trips encoded segments and query; Settings Plugins parses", () => {
  const target = routes.plugin("owner/a", "check list", { repo: "/tmp/project", scope: "repo:demo" });
  const route = at(hrefFor(target));
  expect(route).toEqual({ name: "plugin", plugin: "owner/a", id: "check list", query: { repo: "/tmp/project", scope: "repo:demo" } });
  expect(primaryFor(route)).toBeNull();
  expect(at(hrefFor(routes.settings("plugins")))).toMatchObject({ name: "settings", section: "plugins" });
});
test("rail shows board section, visible activity, active state and Add destination", () => {
  const html = rail([surface, { ...surface, id: "hidden", title: "Hidden", visible: false }, { ...surface, id: "tab", title: "Tab", surface: "panelTabs" }]);
  expect(html).toContain('>Plugins</span>');
  expect(html).toContain('title="Release checklist (plugin)"');
  expect(html).toContain('aria-label="Release checklist (plugin)"');
  expect(html).toContain('href="#/plugins/fx-ui/checklist"');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('href="#/settings/plugins"');
  expect(html).toContain('aria-label="Add a plugin"');
  expect(html).not.toContain('Hidden'); expect(html).not.toContain('Tab (plugin)');
  expect(html.indexOf('pc-rail__divider')).toBeLessThan(html.indexOf('>Plugins<'));
  expect(html.match(/pc-rail__divider/g)?.length).toBe(1);
  expect(rail([])).toContain('Add a plugin');
  expect(rail([], true)).not.toContain('Add a plugin');
  expect(rail([surface], true)).not.toContain('Release checklist');
});
test("every closed plugin icon has a DS mapping", () => {
  for (const name of UI_ICONS) expect(PLUGIN_ICONS[name]).toBeTruthy();
  expect(Object.keys(PLUGIN_ICONS).sort()).toEqual([...UI_ICONS].sort());
});
test("all node types render with literal plugin strings and only host destinations", () => {
  const text = '<b>x</b> javascript:alert(1)';
  const document: ViewNode = { type: "section", title: text, children: [{ type: "stack", gap: "related", children: [
    { type: "heading", level: 2, text }, { type: "heading", level: 3, text }, { type: "text", text, tone: "muted" },
    { type: "keyValue", items: [{ label: text, value: text }] },
    { type: "list", empty: text, items: [{ title: text, subtitle: text, status: { label: text, tone: "good" }, action: "open" }] },
    { type: "list", empty: text, items: [] }, { type: "status", label: text, tone: "warn" },
    { type: "meter", label: text, usedPct: 20, pacePct: 30 }, { type: "code", text },
    { type: "link", label: text, to: { route: "sessions", taskId: "task-1" } },
    { type: "button", label: text, action: "open", variant: "quiet" },
    { type: "checkbox", label: text, name: "checked", checked: false, action: "toggle" }, { type: "empty", title: text, body: text },
  ] }] };
  const html = renderToString(<ViewDocument document={document} onAction={() => {}} />);
  expect(html).toContain('&lt;b>x&lt;/b>'); expect(html).not.toContain('<b>');
  expect(html).toContain('href="#/tasks/task-1"'); expect(html).not.toContain('href="javascript:');
  expect(html).not.toMatch(/style="[^\"]*(?:javascript|alert|&lt;b)/);
  expect(html).toContain('<h2'); expect(html).toContain('<h3'); expect(html).not.toContain('<h1');
  expect(html).toContain('<pre'); expect(html).toContain('<code>'); expect(html).toContain('type="checkbox"');
  for (const route of UI_ROUTES) expect(hrefFor(pluginLink({ route }))).toStartWith('#/');
});
test("busy actions have a visible reason and checkbox sends its value", () => {
  const node: ViewNode = { type: "checkbox", name: "done", checked: false, action: "toggle", label: "Done" };
  const actions: unknown[] = [];
  const view = ViewDocument({ document: node, busy: true, onAction: action => actions.push(action) });
  expect(renderToString(view)).toContain('Working…'); expect(renderToString(view)).toContain('aria-disabled="true"');
  (view.props as any).onChange({ currentTarget: { checked: true } });
  expect(actions).toEqual([{ action: "toggle", label: "Done", values: { done: true } }]);
});
test("confirmation names plugin, quotes body, and cancel declines before sending", async () => {
  const asks: string[][] = [];
  for (const action of [{ action: "delete", label: "Delete", variant: "danger" as const }, { action: "go", label: "Go", confirm: { title: "Proceed?", body: "<b>body</b>" } }]) {
    let sent = false;
    if (await confirmPluginAction("fx-ui", action, async (...args) => { asks.push(args); return false; })) sent = true;
    expect(sent).toBe(false);
  }
  expect(asks[0]).toEqual(['“Delete”', 'fx-ui asks to Delete', 'Continue']);
  expect(asks[1]).toEqual(['“<b>body</b>”', 'fx-ui asks: Proceed?', 'Continue']);
  expect(await confirmPluginAction('fx-ui', { action: 'go', label: 'Go' }, async () => { throw Error('unexpected'); })).toBe(true);
});
test("host error states never display server or plugin error text", () => {
  for (const [code, title, retry] of [
    ['plugin_unavailable', 'This plugin is turned off or needs attention.', false],
    ['plugin_timeout', "This plugin didn't answer in time.", true],
    ['invalid_input', "This plugin's view couldn't be shown.", false],
    ['unknown_plugin', 'This plugin view no longer exists.', false], ['not_found', 'This plugin view no longer exists.', false],
    ['other', "Couldn't load this plugin view.", true],
  ] as const) {
    const html = renderToString(<PluginError error={{ code, message: '<script>evil</script>' }} retry={() => {}} />);
    expect(html).toContain(title); expect(html.includes('>Retry</button>')).toBe(retry);
    expect(html).not.toContain('evil');
    if (code === 'plugin_unavailable') expect(html).toContain('href="#/settings/plugins"');
  }
});
