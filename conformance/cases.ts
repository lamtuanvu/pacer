import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installFixture, type FixtureName } from "./install";
import { HostError, type HostSession } from "./host";

export interface CaseContext {
  home: string; pluginsDir: string;
  install(name: FixtureName, overrides?: Parameters<typeof installFixture>[2]): string;
  host(): Promise<HostSession>;
  sleep(ms: number): Promise<void>;
}
export interface ConformanceCase { name: string; run(t: CaseContext): Promise<void> }

export function assert(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(`conformance: ${message}`); }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
type Info = { id: string; state: string; pid: number | null; error: string | null; version: string };
type Report = { id: string; ok: boolean; state: string; served: string[]; pid: number | null; restarts: number; error: string | null; needs: string | null };
const listed = async (h: HostSession) => Object.fromEntries(((await h.call<{ plugins: Info[] }>("plugin.list")).plugins).map(p => [p.id, p]));
const doctor = async (h: HostSession, id: string) => (await h.call<{ reports: Report[] }>("plugin.doctor", { id })).reports[0]!;
/** Events arrive through a polled subscription, so wait for them instead of checking once. */
const eventually = async (seen: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!seen() && Date.now() < end) await Bun.sleep(50); return seen(); };
const codeOf = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return e instanceof HostError ? e.code : String(e); } };

export const CASES: ConformanceCase[] = [
  { name: "discovery and listing", async run(t) {
    for (const f of ["good", "old-protocol", "bad-manifest", "mismatch"] as const) t.install(f);
    const h = await t.host(), by = await listed(h);
    assert(by["fx-good"]?.state === "needs_grant", "an installed plugin without a grant is needs_grant");
    assert(by["fx-old"]?.state === "refused" && /\^0/.test(by["fx-old"].error ?? ""), "a host range mismatch is refused with the range");
    assert(by["fx-bad"]?.state === "refused" && /JSON/.test(by["fx-bad"].error ?? ""), "a broken manifest is refused with the reason");
    assert(by["fx-mismatch"]?.state === "refused" && /fx-other/.test(by["fx-mismatch"].error ?? ""), "an id that differs from the folder is refused");
    assert(await codeOf(h.call("plugin.enable", { id: "fx-old", grant: true })) === "plugin_refused", "enable on a refused plugin returns plugin_refused");
    assert(await codeOf(h.call("plugin.doctor", { id: "nope" })) === "unknown_plugin", "unknown ids return unknown_plugin");
  } },
  { name: "handshake checks identity, protocol major and served points", async run(t) {
    t.install("claims"); t.install("good", { manifest: { version: "9.9.9" } });
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-claims", grant: true });
    const r = await doctor(h, "fx-claims");
    assert(r.ok && r.served.join() === "diagnostic", `a claimed point the manifest lacks is not served (got ${r.served.join()})`);
    assert((await listed(h))["fx-good"]?.version === "9.9.9", "the listing shows the manifest version");
  } },
  { name: "lazy start: list starts nothing, doctor starts the process", async run(t) {
    t.install("good");
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-good", grant: true });
    assert((await listed(h))["fx-good"]?.pid === null, "no pid before the first call");
    const r = await doctor(h, "fx-good");
    assert(r.ok && r.pid !== null && alive(r.pid), "doctor starts the plugin and reports its pid");
    assert((await listed(h))["fx-good"]?.state === "ready", "the plugin is ready after the first call");
  } },
  { name: "deadline: plugin_timeout, the process survives, a later ping works", async run(t) {
    t.install("slow");
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-slow", grant: true });
    const t0 = Date.now(), first = await doctor(h, "fx-slow");
    assert(!first.ok && /^plugin_timeout/.test(first.error ?? ""), `the slow ping reports plugin_timeout (got ${first.error})`);
    assert(Date.now() - t0 >= 4500 && Date.now() - t0 < 8000, "the deadline is about 5 s");
    assert(first.pid !== null && alive(first.pid), "the process survives a timeout");
    const second = await doctor(h, "fx-slow");
    assert(second.ok && second.pid === first.pid, "a later ping on the same process works");
  } },
  { name: "crash and backoff: restarts, then failing after three crashes, enable clears", async run(t) {
    t.install("crasher");
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-crasher", grant: true });
    const pids: number[] = [];
    for (let i = 0; i < 3; i++) { const r = await doctor(h, "fx-crasher"); assert(r.ok, `ping ${i + 1} works before the crash`); pids.push(r.pid!); await t.sleep(250); }
    assert(new Set(pids).size === 3, "each restart is a new process");
    const failing = await doctor(h, "fx-crasher");
    assert(!failing.ok && failing.state === "failing" && failing.restarts === 3 && /3 failures within a minute/.test(failing.error ?? ""), `three crashes within a minute mark the plugin failing (got ${failing.state}: ${failing.error})`);
    assert(await eventually(() => h.events.some(e => e.type === "plugin" && (e.data as { state: string }).state === "failing")), "a plugin event announces the failing state");
    const after = await h.call<{ state: string }>("plugin.enable", { id: "fx-crasher", grant: true });
    assert(after.state === "idle", "enable clears failing");
    assert((await doctor(h, "fx-crasher")).ok, "the plugin runs again after enable");
  } },
  { name: "capability denial: undeclared calls are refused, declared ones answer", async run(t) {
    t.install("good"); t.install("undeclared"); t.install("over-privileged");
    writeFileSync(join(t.home, ".pacer", "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  config:\n    fx-good: { region: eu }\n");
    const h = await t.host();
    for (const id of ["fx-good", "fx-undeclared", "fx-over"]) await h.call("plugin.enable", { id, grant: true });
    assert((await doctor(h, "fx-good")).ok, "a declared config.get answers");
    const denied = await doctor(h, "fx-undeclared");
    assert(!denied.ok && /^capability_denied/.test(denied.error ?? ""), `an undeclared capability is refused (got ${denied.error})`);
    const unimplemented = await doctor(h, "fx-over");
    assert(!unimplemented.ok && /^capability_denied/.test(unimplemented.error ?? ""), "a declared but unavailable capability is refused without side effects");
  } },
  { name: "grants: needs_grant until granted, and again when a version asks for more", async run(t) {
    const dir = t.install("good");
    const h = await t.host();
    const first = await h.call<{ state: string; needs?: string[] }>("plugin.enable", { id: "fx-good" });
    assert(first.state === "needs_grant" && first.needs?.join() === "log,config.get", "enable without grant returns the capability set");
    assert((await h.call<{ state: string }>("plugin.enable", { id: "fx-good", grant: true })).state === "idle", "enable with grant records it");
    const m = JSON.parse(readFileSync(join(dir, "pacer-plugin.json"), "utf8"));
    writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify({ ...m, version: "1.1.0", capabilities: [...m.capabilities, { name: "net.http" }] }));
    assert((await listed(h))["fx-good"]?.state === "needs_grant", "a version asking for more drops back to needs_grant");
    writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify({ ...m, version: "1.1.0" }));
    assert((await listed(h))["fx-good"]?.state === "idle", "a version with the same capabilities stays enabled");
  } },
  { name: "serialisation: one call at a time unless reentrant", async run(t) {
    t.install("serial"); t.install("reentrant");
    const h = await t.host();
    for (const id of ["fx-serial", "fx-reentrant"]) { await h.call("plugin.enable", { id, grant: true }); await doctor(h, id); }
    const time = async (id: string) => { const t0 = Date.now(); await Promise.all([doctor(h, id), doctor(h, id)]); return Date.now() - t0; };
    const serial = await time("fx-serial"), reentrant = await time("fx-reentrant");
    assert(serial >= 600, `two pings to a non-reentrant plugin run in order (took ${serial} ms)`);
    assert(reentrant < 550, `two pings to a reentrant plugin overlap (took ${reentrant} ms)`);
  } },
  { name: "logs: stderr lands in the plugin log file, never on stdout", async run(t) {
    t.install("good");
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-good", grant: true });
    assert((await doctor(h, "fx-good")).ok, "ping ok");
    const log = join(t.home, ".pacer", "logs", "plugins", "fx-good.log");
    const end = Date.now() + 3000; while (Date.now() < end && !/ping 1/.test(readFileSync(log, "utf8"))) await t.sleep(20);
    assert(/\[stderr\] fixture fx-good: ping 1/.test(readFileSync(log, "utf8")), "stderr line is in the log file");
    assert(await codeOf(h.call("hello", { protocol: 3 })) === "no error", "the host's stdout stayed valid JSON-RPC");
  } },
  { name: "shutdown: closing the host terminates its plugins", async run(t) {
    t.install("good");
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-good", grant: true });
    const pid = (await doctor(h, "fx-good")).pid!;
    await h.close();
    const end = Date.now() + 5000; while (Date.now() < end && alive(pid)) await t.sleep(50);
    assert(!alive(pid), "the plugin process is gone after the host exits");
  } },
];

export const strategyText = "planner: claude-code\nproviders:\n  claude-code: {}\n";
export function prepareHome(home: string): string { mkdirSync(join(home, ".pacer", "plugins"), { recursive: true }); writeFileSync(join(home, ".pacer", "strategy.yaml"), strategyText); return join(home, ".pacer", "plugins"); }
