import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installFixture } from "../conformance/install";
import { assertCallerCanInvoke } from "../src/api/caller-policy";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/protocol";
import { shutdownPlugins } from "../src/plugins";
import { effectiveConfig } from "../src/plugins/settings";
import { fakeCtx, tmpDir } from "./helpers";

const contexts: ReturnType<typeof fakeCtx>[] = [];
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => shutdownPlugins(ctx))); });
function home() {
  const dir = tmpDir();
  const ctx = fakeCtx({ home: dir, pacerHome: join(dir, ".pacer"), env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` }, now: Date.now() / 1000 });
  contexts.push(ctx);
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(ctx.pacerHome, "plugins"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  return ctx;
}
const errOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return toApiError(e); } };
const context = { route: "overview", theme: "light" } as const;

test("a ui plugin needs a grant that names its surfaces; adding a surface kind asks again", async () => {
  const ctx = home();
  const dir = installFixture("ui", join(ctx.pacerHome, "plugins"));
  expect(await callOp(ctx, "plugin.enable", { id: "fx-ui" })).toMatchObject({ state: "needs_grant", surfaces: ["activity", "panelTabs", "settings", "status"] });
  expect(await callOp(ctx, "plugin.enable", { id: "fx-ui", grant: true })).toMatchObject({ state: "idle" });
  const { plugins } = await callOp(ctx, "plugin.list", {}) as { plugins: { id: string; ui: object }[] };
  expect(plugins.find(p => p.id === "fx-ui")?.ui).toEqual({ activity: 1, panelTabs: 1, settings: 1, status: 1 });
  // A new version that drops a surface kind keeps its grant; one that adds a kind re-prompts.
  const manifestPath = join(dir, "pacer-plugin.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...m, version: "1.1.0", contributes: { ui: { ...m.contributes.ui, panelTabs: [] } } }));
  expect((await callOp(ctx, "plugin.list", {}) as { plugins: { id: string; state: string }[] }).plugins.find(p => p.id === "fx-ui")?.state).toBe("idle");
  // Old grants (no surfaces) cover none: forget the surfaces and the plugin asks once.
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  installed:\n    fx-ui:\n      version: 1.0.0\n      capabilities: [config.get]\n");
  expect((await callOp(ctx, "plugin.list", {}) as { plugins: { id: string; state: string }[] }).plugins.find(p => p.id === "fx-ui")?.state).toBe("needs_grant");
}, 30000);

test("surfaces list only for enabled, granted plugins and start nothing", async () => {
  const ctx = home();
  installFixture("ui", join(ctx.pacerHome, "plugins"));
  expect((await callOp(ctx, "plugin.ui.list", {}) as { surfaces: unknown[] }).surfaces).toEqual([]);
  await callOp(ctx, "plugin.enable", { id: "fx-ui", grant: true });
  const { surfaces } = await callOp(ctx, "plugin.ui.list", {}) as { surfaces: { surface: string; id: string; visible: boolean; context: string }[] };
  expect(surfaces.map(s => `${s.surface}:${s.id}`)).toEqual(["activity:checklist", "panelTabs:checklist-tab", "settings:settings", "status:open-items"]);
  expect(surfaces.find(s => s.id === "checklist-tab")?.context).toBe("task");
  const info = (await callOp(ctx, "plugin.list", {}) as { plugins: { id: string; pid: number | null }[] }).plugins.find(p => p.id === "fx-ui");
  expect(info?.pid).toBeNull();
}, 30000);

test("render, action and visibility go through the host; visibility conflicts on a stale revision", async () => {
  const ctx = home();
  installFixture("ui", join(ctx.pacerHome, "plugins"));
  await callOp(ctx, "plugin.enable", { id: "fx-ui", grant: true });
  const r = await callOp(ctx, "plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context }) as { document: { type: string } };
  expect(r.document.type).toBe("text");
  expect(await callOp(ctx, "plugin.ui.action", { plugin: "fx-ui", surface: "activity", id: "checklist", action: "run", context, requestId: "r1" })).toEqual({ result: "refresh", message: "done" });
  const hidden = await callOp(ctx, "plugin.ui.visibility", { plugin: "fx-ui", surface: "activity", id: "checklist", visible: false, expect_rev: 0 }) as { rev: number };
  expect(hidden.rev).toBe(1);
  expect((await errOf(callOp(ctx, "plugin.ui.visibility", { plugin: "fx-ui", surface: "activity", id: "checklist", visible: true, expect_rev: 0 })))?.code).toBe("conflict");
  expect(((await callOp(ctx, "plugin.ui.list", {}) as { surfaces: { id: string; visible: boolean }[] }).surfaces.find(s => s.id === "checklist"))?.visible).toBe(false);
  expect((await errOf(callOp(ctx, "plugin.ui.visibility", { plugin: "fx-ui", surface: "activity", id: "nope", visible: true, expect_rev: 1 })))?.code).toBe("not_found");
}, 30000);

test("settings round trip: schema validation, conflicts, a 0600 store, and config.get sees the values", async () => {
  const ctx = home();
  installFixture("ui", join(ctx.pacerHome, "plugins"));
  await callOp(ctx, "plugin.enable", { id: "fx-ui", grant: true });
  const first = await callOp(ctx, "plugin.settings.get", { plugin: "fx-ui" }) as { rev: number; schema: { fields: object } };
  expect(first.rev).toBe(0);
  expect(Object.keys(first.schema.fields)).toEqual(["required", "repos", "items"]);
  const bad = await errOf(callOp(ctx, "plugin.settings.set", { plugin: "fx-ui", values: { required: "yes", nope: 1 }, expect_rev: 0 }));
  expect(bad?.code).toBe("invalid_input");
  expect(JSON.stringify(bad)).toContain("required");
  const saved = await callOp(ctx, "plugin.settings.set", { plugin: "fx-ui", values: { required: true, items: ["a", "b"] }, expect_rev: 0 }) as { rev: number };
  expect(saved.rev).toBe(1);
  expect((await errOf(callOp(ctx, "plugin.settings.set", { plugin: "fx-ui", values: { required: false }, expect_rev: 0 })))?.code).toBe("conflict");
  expect(effectiveConfig(ctx, "fx-ui")).toEqual({ required: true, items: ["a", "b"] });
  expect(statSync(join(ctx.pacerHome, "plugin-settings.json")).mode & 0o777).toBe(0o600);
}, 30000);

test("a settings write is refused for a plugin without a page, and the running plugin can veto values", async () => {
  const ctx = home();
  installFixture("good", join(ctx.pacerHome, "plugins"));
  await callOp(ctx, "plugin.enable", { id: "fx-good", grant: true });
  expect((await errOf(callOp(ctx, "plugin.settings.get", { plugin: "fx-good" })))?.code).toBe("not_found");
  const veto = home();
  installFixture("ui", join(veto.pacerHome, "plugins"), { fixture: { validateErrors: [{ path: "items", message: "too vague" }] } });
  await callOp(veto, "plugin.enable", { id: "fx-ui", grant: true });
  await callOp(veto, "plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context });
  const e = await errOf(callOp(veto, "plugin.settings.set", { plugin: "fx-ui", values: { items: ["x"] }, expect_rev: 0 }));
  expect(e?.code).toBe("invalid_input");
  expect(JSON.stringify(e)).toContain("too vague");
}, 30000);

test("executor sessions cannot use plugin ui or settings ops", () => {
  const ctx = home();
  const executor = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor" } };
  for (const op of ["plugin.ui.list", "plugin.ui.render", "plugin.ui.action", "plugin.ui.visibility", "plugin.settings.get", "plugin.settings.set"]) expect(() => assertCallerCanInvoke(executor, op, {})).toThrow();
  expect(() => assertCallerCanInvoke(executor, "plugin.list", {})).not.toThrow();
});

test("settings validation rejects prototype-chain keys and the store survives corruption", async () => {
  const { validateSettings } = await import("../src/plugins/settings");
  const schema = { fields: { a: { type: "boolean" as const, title: "A" } } };
  expect(validateSettings(schema, JSON.parse('{"constructor":{"a":1},"toString":5,"__proto__":{"x":1}}')).map(e => e.path).sort()).toEqual(["__proto__", "constructor", "toString"]);
  const ctx = home();
  installFixture("ui", join(ctx.pacerHome, "plugins"));
  await callOp(ctx, "plugin.enable", { id: "fx-ui", grant: true });
  writeFileSync(join(ctx.pacerHome, "plugin-settings.json"), "{broken");
  expect(((await callOp(ctx, "plugin.settings.get", { plugin: "fx-ui" })) as { rev: number }).rev).toBe(0);
  const kept = (await import("node:fs")).readdirSync(ctx.pacerHome).filter(f => f.startsWith("plugin-settings.json.corrupt-"));
  expect(kept.length).toBe(1);
});

test("removing a plugin forgets its settings", async () => {
  const ctx = home();
  installFixture("ui", join(ctx.pacerHome, "plugins"));
  await callOp(ctx, "plugin.enable", { id: "fx-ui", grant: true });
  await callOp(ctx, "plugin.settings.set", { plugin: "fx-ui", values: { required: true }, expect_rev: 0 });
  await callOp(ctx, "plugin.remove", { id: "fx-ui" });
  expect(effectiveConfig(ctx, "fx-ui")).toEqual({});
}, 30000);

test("a disabled plugin's cached documents are not served", async () => {
  const ctx = home();
  installFixture("ui", join(ctx.pacerHome, "plugins"), { fixture: {} });
  await callOp(ctx, "plugin.enable", { id: "fx-ui", grant: true });
  await callOp(ctx, "plugin.ui.render", { plugin: "fx-ui", surface: "status", id: "open-items", context }).catch(() => undefined);
  await callOp(ctx, "plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context });
  await callOp(ctx, "plugin.ui.render", { plugin: "fx-ui", surface: "status", id: "open-items", context });
  await callOp(ctx, "plugin.disable", { id: "fx-ui" });
  expect((await errOf(callOp(ctx, "plugin.ui.render", { plugin: "fx-ui", surface: "status", id: "open-items", context })))?.code).toBe("plugin_unavailable");
}, 30000);

test("executor sessions cannot grant plugins", () => {
  const ctx = home();
  const executor = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor" } };
  expect(() => assertCallerCanInvoke(executor, "plugin.enable", { id: "x", grant: true })).toThrow();
  expect(() => assertCallerCanInvoke(executor, "plugin.enable", { id: "x" })).not.toThrow();
});
