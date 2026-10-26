// test/plugins-process.test.ts
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installFixture, type FixtureName } from "../conformance/install";
import { CoreError } from "../src/core/errors";
import { PluginProcess } from "../src/plugins/process";
import { PLUGIN_PROTOCOL_VERSION } from "../src/plugins/protocol";

const root = join(import.meta.dir, "..", ".work", "conformance", "process-test");
function start(name: FixtureName, onRequest: (m: string, p: unknown) => Promise<unknown> = async () => ({})) {
  mkdirSync(root, { recursive: true });
  const dir = installFixture(name, root);
  const stderr: string[] = []; let exit: { code: number | null; signal: string | null } | null = null;
  const p = new PluginProcess({ argv: [join(dir, "main.ts")], cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME } }, { onRequest, onStderr: l => stderr.push(l), onExit: i => { exit = i; } });
  const manifest = JSON.parse(require("node:fs").readFileSync(join(dir, "pacer-plugin.json"), "utf8"));
  const hello = () => p.request("plugin.hello", { protocol: PLUGIN_PROTOCOL_VERSION, pacer: "0", manifest, config: {}, grants: [] }, 10000);
  return { p, hello, stderr, exit: () => exit };
}
const codeOf = async (x: Promise<unknown>) => { try { await x; return "no error"; } catch (e) { return e instanceof CoreError ? e.code : String(e); } };

test("handshake, ping, stderr capture and terminate", async () => {
  const s = start("good", async m => (m === "capability.config.get" ? { config: {} } : {}));
  expect(await s.hello()).toMatchObject({ id: "fx-good", protocol: "1.5.0" });
  expect(await s.p.request("diagnostic.ping", {}, 5000)).toMatchObject({ ok: true });
  const end = Date.now() + 2000; while (!s.stderr.length && Date.now() < end) await Bun.sleep(10);
  expect(s.stderr[0]).toContain("fx-good: ping 1");
  await s.p.terminate();
  expect(s.p.alive).toBe(false);
  expect(s.exit()).not.toBeNull();
}, 15000);

test("a deadline cancels the call, keeps the process and a later call works", async () => {
  const s = start("slow");
  await s.hello();
  const t0 = Date.now();
  expect(await codeOf(s.p.request("diagnostic.ping", {}, 500))).toBe("plugin_timeout");
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(s.p.alive).toBe(true);
  expect(await s.p.request("diagnostic.ping", {}, 5000)).toMatchObject({ ok: true });
  await s.p.terminate();
}, 15000);

test("an exit rejects pending calls and plugin errors keep their code", async () => {
  const s = start("undeclared", async () => { throw new CoreError("capability_denied", "fx-undeclared did not declare config.get"); });
  await s.hello();
  expect(await codeOf(s.p.request("diagnostic.ping", {}, 5000))).toBe("capability_denied");
  const c = start("crasher");
  await c.hello();
  expect(await c.p.request("diagnostic.ping", {}, 5000)).toMatchObject({ ok: true });
  await c.p.exited;
  expect(c.exit()).toMatchObject({ code: 7 });
  expect(await codeOf(c.p.request("diagnostic.ping", {}, 5000))).toBe("plugin_unavailable");
  await s.p.terminate();
}, 15000);
