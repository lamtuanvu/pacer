// test/plugins-registry.test.ts
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { installFixture } from "../conformance/install";
import { eventsSince } from "../src/api/events";
import { readActivity } from "../src/activity/log";
import { CoreError } from "../src/core/errors";
import { PluginRegistry } from "../src/plugins/registry";
import { pluginLogPath } from "../src/plugins/host";
import { fakeCtx } from "./helpers";

// Temporary fixtures resolve the workspace SDK without writing under .work.
const base = mkdtempSync(join(tmpdir(), "pacer-registry-"));
symlinkSync(join(import.meta.dir, "..", "node_modules"), join(base, "node_modules"), "dir");
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
function home() {
  const dir = join(base, `h${Date.now()}-${n++}`);
  const ctx = fakeCtx({ home: dir, pacerHome: join(dir, ".pacer"), env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` }, now: Date.now() / 1000 });
  mkdirSync(join(ctx.pacerHome, "plugins"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  return ctx;
}
const live = (ctx: ReturnType<typeof fakeCtx>) => ({ ...ctx, now: Date.now() / 1000 });
const registries: PluginRegistry[] = [];
afterEach(async () => { await Promise.all(registries.splice(0).map(r => r.shutdown())); });
const registry = (sleep?: (ms: number) => Promise<void>) => {
  const r = new PluginRegistry({ bundled: [], spawnBundled: () => { throw new Error("no bundled plugins"); }, sleep });
  registries.push(r);
  return r;
};
const codeOf = async (x: Promise<unknown>) => { try { await x; return "no error"; } catch (e) { return e instanceof CoreError ? e.code : String(e); } };

test("discovery lists installed plugins with their static states", async () => {
  const ctx = home();
  for (const f of ["good", "old-protocol", "bad-manifest", "mismatch"] as const) installFixture(f, join(ctx.pacerHome, "plugins"));
  const r = registry();
  const byId = Object.fromEntries(r.list(ctx).map(p => [p.id, p]));
  expect(byId["fx-good"]).toMatchObject({ state: "needs_grant", enabled: false, bundled: false, capabilities: [{ name: "log" }, { name: "config.get" }], pid: null });
  expect(byId["fx-old"]).toMatchObject({ state: "refused" }); expect(byId["fx-old"].error).toContain("^0");
  expect(byId["fx-bad"]).toMatchObject({ state: "refused" }); expect(byId["fx-bad"].error).toContain("JSON");
  expect(byId["fx-mismatch"]).toMatchObject({ state: "refused" }); expect(byId["fx-mismatch"].error).toContain("fx-other");
  expect(await codeOf(r.call(ctx, "fx-good", "diagnostic.ping", {}))).toBe("plugin_unavailable");
  expect(await codeOf(r.call(ctx, "nope", "diagnostic.ping", {}))).toBe("unknown_plugin");
});

test("shutdown drains a burst of plugin state events in transition order", async () => {
  const ctx = home();
  const dir = installFixture("good", join(ctx.pacerHome, "plugins"));
  const path = join(dir, "pacer-plugin.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const r = registry();
  const expected = ["needs_grant"];
  r.refresh(ctx);
  for (let i = 0; i < 8; i++) {
    writeFileSync(path, JSON.stringify({ ...manifest, host: "^0.0.0" }));
    r.refresh(ctx);
    expected.push("refused");
    writeFileSync(path, JSON.stringify(manifest));
    r.refresh(ctx);
    expected.push("needs_grant");
  }
  await r.shutdown();
  const states = eventsSince(ctx, 0, 3).events
    .filter(e => e.type === "plugin" && (e.data as { id: string }).id === "fx-good")
    .map(e => (e.data as { state: string }).state);
  expect(states).toEqual(expected);
});

test("enable needs a grant once, then starts lazily, answers declared capabilities and logs", async () => {
  const ctx = home();
  installFixture("good", join(ctx.pacerHome, "plugins"));
  const r = registry();
  expect(await r.enable(ctx, "fx-good", false)).toEqual({ id: "fx-good", state: "needs_grant", needs: ["log", "config.get"] });
  expect(await r.enable(ctx, "fx-good", true)).toEqual({ id: "fx-good", state: "idle" });
  expect(r.list(ctx).find(p => p.id === "fx-good")).toMatchObject({ enabled: true, grant: { version: "1.0.0", capabilities: ["log", "config.get"] }, pid: null });
  const [report] = await r.doctor(live(ctx), "fx-good");
  expect(report).toMatchObject({ id: "fx-good", ok: true, state: "ready", served: ["diagnostic"], protocol: { host: "1.0.0", plugin: "1.0.0" }, restarts: 0 });
  expect(report.pid).toBeGreaterThan(0);
  const end = Date.now() + 2000; while (!readFileSync(pluginLogPath(ctx, "fx-good"), "utf8").includes("ping 1") && Date.now() < end) await Bun.sleep(10);
  expect(readFileSync(pluginLogPath(ctx, "fx-good"), "utf8")).toContain("[stderr] fixture fx-good: ping 1");
  const published = Date.now() + 2000;
  while (eventsSince(ctx, 0, 3).events.filter(e => e.type === "plugin").length < 4 && Date.now() < published) await Bun.sleep(10);
  const types = eventsSince(ctx, 0, 3).events.filter(e => e.type === "plugin").map(e => (e.data as { state: string }).state);
  expect(types).toEqual(["needs_grant", "idle", "starting", "ready"]);
  await r.disable(live(ctx), "fx-good");
  expect(r.list(ctx).find(p => p.id === "fx-good")).toMatchObject({ state: "disabled", pid: null });
  await r.shutdown();
}, 20000);

test("undeclared capabilities are denied and a version with more capabilities needs a new grant", async () => {
  const ctx = home();
  const dir = installFixture("undeclared", join(ctx.pacerHome, "plugins"));
  const r = registry();
  await r.enable(ctx, "fx-undeclared", true);
  expect(await codeOf(r.call(live(ctx), "fx-undeclared", "diagnostic.ping", {}))).toBe("capability_denied");
  const manifest = JSON.parse(readFileSync(join(dir, "pacer-plugin.json"), "utf8"));
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify({ ...manifest, version: "1.1.0", capabilities: [{ name: "config.get" }] }));
  expect(r.list(ctx).find(p => p.id === "fx-undeclared")).toMatchObject({ state: "needs_grant", version: "1.1.0" });
  await r.shutdown();
}, 20000);

test("three crashes within a minute mark the plugin failing; enable clears it", async () => {
  const ctx = home();
  installFixture("crasher", join(ctx.pacerHome, "plugins"));
  const waits: number[] = [];
  const r = registry(async ms => { waits.push(ms); });
  await r.enable(ctx, "fx-crasher", true);
  for (let i = 0; i < 3; i++) {
    expect(await r.call(live(ctx), "fx-crasher", "diagnostic.ping", {})).toMatchObject({ ok: true });
    await Bun.sleep(150);
  }
  expect(waits).toHaveLength(2);
  expect(waits[0]).toBeGreaterThan(0);
  expect(waits[0]).toBeLessThanOrEqual(1000);
  expect(waits[1]).toBeGreaterThan(1000);
  expect(waits[1]).toBeLessThanOrEqual(2000);
  expect(r.list(ctx).find(p => p.id === "fx-crasher")).toMatchObject({ state: "failing" });
  expect(await codeOf(r.call(live(ctx), "fx-crasher", "diagnostic.ping", {}))).toBe("plugin_unavailable");
  expect(readActivity(ctx, { kinds: ["plugin_state"] }).entries.map(e => e.text)).toEqual([expect.stringContaining("fx-crasher")]);
  expect(await r.enable(live(ctx), "fx-crasher", true)).toEqual({ id: "fx-crasher", state: "idle" });
  expect(await r.call(live(ctx), "fx-crasher", "diagnostic.ping", {})).toMatchObject({ ok: true });
  await r.shutdown();
}, 20000);

test("calls serialise unless the manifest is reentrant", async () => {
  const ctx = home();
  installFixture("serial", join(ctx.pacerHome, "plugins")); installFixture("reentrant", join(ctx.pacerHome, "plugins"));
  const r = registry();
  await r.enable(ctx, "fx-serial", true); await r.enable(ctx, "fx-reentrant", true);
  // Measure call overlap independently of subprocess startup time.
  await r.doctor(live(ctx));
  const time = async (id: string) => { const t0 = Date.now(); await Promise.all([r.call(live(ctx), id, "diagnostic.ping", {}), r.call(live(ctx), id, "diagnostic.ping", {})]); return Date.now() - t0; };
  expect(await time("fx-serial")).toBeGreaterThanOrEqual(600);
  expect(await time("fx-reentrant")).toBeLessThan(550);
  await r.shutdown();
}, 20000);
