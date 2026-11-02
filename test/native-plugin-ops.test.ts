import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installFixture } from "../conformance/install";
import { tmpDir } from "./helpers";

const front = process.env.PACER_TEST_FRONT_DOOR;
const context = { route: "overview", theme: "light" };

async function service(forward = "") {
  const home = realpathSync(tmpDir()), state = join(home, ".pacer");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n# preserve this comment\n", { mode: 0o600 });
  symlinkSync(join(import.meta.dir, "../node_modules"), join(home, "node_modules"), "dir");
  const plugin = installFixture("ui", join(state, "plugins"));
  const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = socket.port!; socket.stop(true);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], {
    env: { HOME: home, PACER_HOME: state, PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      PACER_CORE_ARGV: JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]),
      PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", PACER_FORWARD_OPS: forward },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const logs = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  try {
    for (let i = 0; i < 500; i++) {
      try {
        token = readFileSync(join(state, "token"), "utf8").trim();
        const response = await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch { /* Wait for this owned child only. */ }
      if (child.exitCode !== null) throw Error(await logs);
      await Bun.sleep(20);
    }
    if (!token) throw Error("native fixture did not become ready");
  } catch (error) { child.kill("SIGTERM"); await child.exited; throw error; }
  const post = async (op: string, params: unknown) => {
    const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000) });
    return await response.json() as any;
  };
  return { home, state, plugin, base, token, post, async stop() {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    return logs;
  } };
}

test.skipIf(!front)("the whole public plugin operation set matches forced TypeScript fallback", async () => {
  const results: unknown[][] = [];
  for (const forward of ["", "*"]) {
    const s = await service(forward), actual: unknown[] = [];
    try {
      const fx = async () => (await s.post("plugin.list", {})).result.plugins.find((p: any) => p.id === "fx-ui");
      actual.push((await fx()).state);
      actual.push(await s.post("plugin.enable", { id: "fx-ui" }));
      const enabled = await s.post("plugin.enable", { id: "fx-ui", grant: true });
      expect(enabled, JSON.stringify(enabled)).toEqual({ result: { id: "fx-ui", state: "idle" } });
      actual.push(enabled);
      actual.push(await s.post("plugin.ui.list", {}));
      for (const op of ["plugin.ui.render", "plugin.ui.action", "plugin.ui.visibility"]) {
        actual.push(await s.post(op, { plugin: "fx-ui", surface: "activity", id: "missing", context, action: "run", requestId: "r", visible: false, expect_rev: 0 }));
      }
      expect((await fx()).pid).toBeNull();
      actual.push(await s.post("plugin.ui.render", { plugin: "fx-ui", surface: "status", id: "open-items", context }));
      expect((await fx()).pid).toBeNull();
      actual.push(await s.post("plugin.settings.get", { plugin: "fx-ui" }));
      actual.push(await s.post("plugin.settings.set", { plugin: "fx-ui", values: { required: "yes", nope: 1 }, expect_rev: 0 }));
      const save = { plugin: "fx-ui", values: { required: true, items: ["a", "b"] }, expect_rev: 0 };
      actual.push(await s.post("plugin.settings.set", save));
      actual.push(await s.post("plugin.settings.set", save));
      const visibility = { plugin: "fx-ui", surface: "activity", id: "checklist", visible: false, expect_rev: 1 };
      actual.push(await s.post("plugin.ui.visibility", visibility));
      actual.push(await s.post("plugin.ui.visibility", visibility));
      const render = await s.post("plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context });
      expect(render.error, JSON.stringify(render)).toBeUndefined();
      actual.push({ ...render.result, renderedAt: 0 });
      const statusParams = { plugin: "fx-ui", surface: "status", id: "open-items", context };
      const status = await s.post("plugin.ui.render", statusParams);
      expect(status.error, JSON.stringify(status)).toBeUndefined();
      expect(status.result.ttlS).toBe(30);
      expect(await s.post("plugin.ui.render", statusParams)).toEqual(status);
      actual.push(await s.post("plugin.ui.action", { plugin: "fx-ui", surface: "activity", id: "checklist", context, action: "run", requestId: "r1" }));
      const doctor = await s.post("plugin.doctor", { id: "fx-ui" });
      expect(doctor.error).toBeUndefined();
      actual.push({ ...doctor.result.reports[0], pid: 0 });
      writeFileSync(join(s.plugin, "fixture.json"), JSON.stringify({ validateErrors: [{ path: "items", message: "too vague" }] }));
      // The process retains its startup fixture; native and fallback must do so too.
      actual.push(await s.post("plugin.settings.set", { plugin: "fx-ui", values: { items: ["x"] }, expect_rev: 2 }));
      actual.push(await s.post("plugin.disable", { id: "fx-ui" }));
      actual.push(await s.post("plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context }));
      actual.push(await s.post("plugin.remove", { id: "fx-ui" }));
      actual.push(await s.post("plugin.enable", { id: "fx-ui" }));
      actual.push(await s.post("plugin.install", {}));
      for (const params of [null, [], { plugin: "Bad" }, { plugin: "fx-ui", values: {}, expect_rev: 1.5 }]) actual.push(await s.post("plugin.settings.set", params));
      expect(readFileSync(join(s.state, "strategy.yaml"), "utf8")).toContain("# preserve this comment");
      expect((await fetch(`${s.base}/_internal/plugins`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` }, body: "{}" })).status).toBe(404);
      results.push(actual);
    } finally {
      const log = await s.stop();
      if (!forward && results.length > 0) for (const op of ["plugin.list", "plugin.enable", "plugin.disable", "plugin.remove", "plugin.doctor", "plugin.ui.list", "plugin.ui.render", "plugin.ui.action", "plugin.ui.visibility", "plugin.settings.get", "plugin.settings.set", "plugin.install"]) expect(log).toContain(`native ${op}`);
      else if (forward) expect(log).not.toMatch(/^native plugin\./m);
    }
  }
  expect(results[0]).toEqual(results[1]);
}, 90000);

test.skipIf(!front)("native settings CAS, ready-plugin veto and private modes", async () => {
  const s = await service();
  try {
    writeFileSync(join(s.plugin, "fixture.json"), JSON.stringify({ validateErrors: [{ path: "items", message: "too vague" }] }));
    const enabled = await s.post("plugin.enable", { id: "fx-ui", grant: true });
    expect(enabled, JSON.stringify(enabled)).toEqual({ result: { id: "fx-ui", state: "idle" } });
    const writes = await Promise.all([true, false].map(required => s.post("plugin.settings.set", { plugin: "fx-ui", values: { required }, expect_rev: 0 })));
    expect(writes.filter(w => w.result?.rev === 1), JSON.stringify(writes)).toHaveLength(1);
    expect(writes.filter(w => w.error?.code === "conflict")).toHaveLength(1);
    await s.post("plugin.doctor", { id: "fx-ui" });
    const veto = await s.post("plugin.settings.set", { plugin: "fx-ui", values: { items: ["x"] }, expect_rev: 1 });
    expect(veto.error).toMatchObject({ code: "invalid_input", data: { errors: [{ path: "items", message: "too vague" }] } });
    expect((await s.post("plugin.settings.get", { plugin: "fx-ui" })).result.rev).toBe(1);
    const { statSync } = await import("node:fs");
    for (const file of ["strategy.yaml", "plugin-settings.json"]) expect(statSync(join(s.state, file)).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.state, "orca")).mode & 0o777).toBe(0o700);
  } finally { await s.stop(); }
}, 45000);

test.skipIf(!front)("native and individually forwarded UI operations share targeted invalidation", async () => {
  for (const forward of ["plugin.ui.action", "plugin.ui.render"]) {
    const s = await service(forward);
    try {
      await s.post("plugin.enable", { id: "fx-ui", grant: true });
      await s.post("plugin.doctor", { id: "fx-ui" });
      const status = { plugin: "fx-ui", surface: "status", id: "open-items", context };
      const before = await s.post("plugin.ui.render", status);
      expect(before.error, JSON.stringify(before)).toBeUndefined();
      const activity = { plugin: "fx-ui", surface: "activity", id: "checklist", context };
      await s.post("plugin.ui.action", { ...activity, action: "run", requestId: "activity" });
      expect(await s.post("plugin.ui.render", status)).toEqual(before);
      await s.post("plugin.ui.action", { ...status, action: "run", requestId: "status" });
      const after = await s.post("plugin.ui.render", status);
      expect(after.error, JSON.stringify(after)).toBeUndefined();
      expect(after.result.document.text).not.toBe(before.result.document.text);
    } finally { await s.stop(); }
  }
}, 45000);
