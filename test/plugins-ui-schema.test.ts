// test/plugins-ui-schema.test.ts
import { expect, test } from "bun:test";
import { parseManifest } from "../src/plugins/manifest";
import { EXTENSION_METHODS, PLUGIN_PROTOCOL_VERSION, UI_ICONS, parseStatusItemDocument, parseViewDocument, uiOf } from "../src/plugins/protocol";

const base = { id: "fx-ui", version: "1.0.0", publisher: "pacer", host: ">=1.2.0", capabilities: [{ name: "config.get" }] };
const ui = { activity: [{ id: "a", title: "Checklist", icon: "check-square", view: "v" }], panelTabs: [{ id: "t", title: "Tab", icon: "list", view: "v", context: "task" }], status: [{ id: "s", title: "Open", view: "s" }],
  settings: [{ id: "settings", title: "Checklist", schema: { fields: { enabled: { type: "boolean", title: "On" }, repos: { type: "repos", title: "Repos" } } } }] };
const m = (u: unknown, over: object = {}) => parseManifest({ ...base, ...over, contributes: { ui: u } });
const page = (fields: object) => ({ settings: [{ id: "s", title: "S", schema: { fields } }] });

test("the protocol is 1.2.0 and serves the three ui methods", () => {
  expect(PLUGIN_PROTOCOL_VERSION).toBe("1.2.0");
  for (const k of ["ui.render", "ui.action", "ui.settings.validate"]) expect(EXTENSION_METHODS[k]).toBeDefined();
});

test("a ui manifest validates and applies defaults", () => {
  const r = m(ui);
  expect(r.ok).toBe(true);
  if (r.ok) expect(uiOf(r.manifest)?.panelTabs[0]?.context).toBe("task");
  expect(UI_ICONS).toContain("check-square");
});

test("ui limits, ids, icons are enforced", () => {
  const three = [1, 2, 3].map(n => ({ id: `a${n}`, title: "x", icon: "list", view: "v" }));
  expect(m({ activity: three }).ok).toBe(false);
  expect(m({ activity: [{ ...ui.activity[0], icon: "<svg>" }] }).ok).toBe(false);
  expect(m({ activity: [{ ...ui.activity[0], id: "Bad Id" }] }).ok).toBe(false);
  expect(m({ activity: [ui.activity[0], ui.activity[0]] }).ok).toBe(false);
  expect(m({ activity: [{ ...ui.activity[0], title: "" }] }).ok).toBe(false);
  expect(m({ activity: [{ ...ui.activity[0], style: "x" }] }).ok).toBe(false);
});

test("a ui manifest needs host >=1.2.0 and the config.get capability for a settings page", () => {
  for (const host of ["^1", ">=1.1.0", "^1.1", "*", "1.1.0"]) expect(m(ui, { host }).ok).toBe(false);
  for (const host of [">=1.2.0", "^1.2", "~1.2.0", "1.2.0", ">=1.3.0"]) expect(m(ui, { host }).ok).toBe(true);
  expect(m(ui, { capabilities: [] }).ok).toBe(false);
  expect(m({ activity: ui.activity }, { capabilities: [] }).ok).toBe(true);
});

test("settings schemas refuse key-like fields, patterns and unbounded integers", () => {
  expect(m(page({ apiKey: { type: "string", title: "Key" } })).ok).toBe(false);
  expect(m(page({ other: { type: "string", title: "Access token" } })).ok).toBe(false);
  expect(m(page({ acme: { type: "secretRef", title: "Acme token" } })).ok).toBe(true);
  expect(m(page({ x: { type: "string", title: "X", pattern: ".*" } })).ok).toBe(false);
  expect(m(page({ n: { type: "integer", title: "N" } })).ok).toBe(false);
  expect(m(page({ n: { type: "integer", title: "N", minimum: 1, maximum: 5 } })).ok).toBe(true);
  expect(m(page({ l: { type: "array", items: { type: "string" }, title: "L", maxItems: 101 } })).ok).toBe(false);
  expect(m(page({ apiTokens: { type: "array", items: { type: "string" }, title: "T", maxItems: 3 } })).ok).toBe(false);
  expect(m(page({ pwd: { type: "string", title: "P" } })).ok).toBe(false);
  expect(m(page({ credential: { type: "repos", title: "C" } })).ok).toBe(false);
});

test("manifest display text is cleaned", () => {
  const r = m({ activity: [{ id: "a", title: "Hi‮\u0000there", icon: "list", view: "v" }] });
  expect(r.ok && uiOf(r.manifest)?.activity[0]?.title).toBe("Hithere");
});

const stack = (children: unknown[]) => ({ type: "stack", gap: "content", children });
test("documents validate, and normalize text", () => {
  const r = parseViewDocument(stack([{ type: "text", text: "Café ‮evil​\u0007ok" }, { type: "button", label: "Run", action: "run", variant: "secondary" }]));
  expect(r.ok).toBe(true);
  if (r.ok && r.document.type === "stack" && r.document.children[0]?.type === "text") expect(r.document.children[0].text).toBe("Café evilok");
});

test("documents reject unknown nodes, unlabeled controls, primary buttons, extra fields and bad links", () => {
  expect(parseViewDocument({ type: "html", html: "<b>" }).ok).toBe(false);
  expect(parseViewDocument({ type: "button", label: "", action: "a", variant: "secondary" }).ok).toBe(false);
  expect(parseViewDocument({ type: "button", label: "​", action: "a", variant: "secondary" }).ok).toBe(false);
  expect(parseViewDocument({ type: "button", label: "Go", action: "a", variant: "primary" }).ok).toBe(false);
  expect(parseViewDocument({ type: "text", text: "x", style: "color:red" }).ok).toBe(false);
  expect(parseViewDocument({ type: "link", label: "x", to: { route: "https://evil" } }).ok).toBe(false);
  expect(parseViewDocument({ type: "link", label: "x", to: { route: "overview", taskId: "‮../x" } }).ok).toBe(false);
  expect(parseViewDocument({ type: "checkbox", label: "", name: "n", checked: true, action: "a" }).ok).toBe(false);
  expect(parseViewDocument({ type: "meter", label: "m", usedPct: 101 }).ok).toBe(false);
});

test("documents are bounded in size, nodes and depth, and errors never echo content", () => {
  let deep: unknown = { type: "text", text: "x" };
  for (let i = 0; i < 8; i++) deep = { type: "stack", gap: "related", children: [deep] };
  expect(parseViewDocument(deep).ok).toBe(false);
  expect(parseViewDocument(stack(Array.from({ length: 501 }, () => ({ type: "text", text: "x" })))).ok).toBe(false);
  expect(parseViewDocument({ type: "text", text: "x".repeat(2001) }).ok).toBe(false);
  expect(parseViewDocument({ type: "code", text: "x".repeat(17 * 1024) }).ok).toBe(false);
  expect(parseViewDocument(stack(Array.from({ length: 400 }, () => ({ type: "code", text: "y".repeat(500) })))).ok).toBe(false);
  const err = parseViewDocument({ type: "text", text: "secret task data".repeat(200) });
  expect(err.ok === false && err.error.includes("secret task data")).toBe(false);
});

test("a status item document is one short node", () => {
  expect(parseStatusItemDocument({ type: "status", label: "3 open", tone: "warn" }).ok).toBe(true);
  expect(parseStatusItemDocument({ type: "text", text: "x".repeat(25) }).ok).toBe(false);
  expect(parseStatusItemDocument(stack([])).ok).toBe(false);
});
