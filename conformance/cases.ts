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

/** Reconstruct overlap from every measured entry/exit, not a claimed maximum. */
export function assertPingReceipts(text: string, reentrant: boolean): void {
  assert(text.length <= 4096, "ping receipts are bounded");
  const rows = text.trim().split("\n").map(line => JSON.parse(line));
  assert(rows.length === 4, "exactly two entries and two exits are recorded");
  const active = new Set<number>(), entered = new Set<number>(), exited = new Set<number>();
  let maximum = 0;
  for (const [index, row] of rows.entries()) {
    assert(Object.keys(row).sort().join() === "active,phase,ping,seq", "receipt has fixed fields");
    assert(row.seq === index + 1 && (row.ping === 2 || row.ping === 3), "receipt sequence excludes warmup and is monotonic");
    if (row.phase === "enter") {
      assert(!entered.has(row.ping), "each measured request enters once");
      entered.add(row.ping); active.add(row.ping);
    } else {
      assert(row.phase === "exit" && active.has(row.ping) && !exited.has(row.ping), "each successful exit matches one active entry");
      assert(!reentrant || entered.size === 2, "both reentrant requests entered before either exited");
      active.delete(row.ping); exited.add(row.ping);
    }
    assert(row.active === active.size, "active receipt matches reconstructed event order");
    maximum = Math.max(maximum, active.size);
  }
  assert(active.size === 0 && entered.size === 2 && exited.size === 2, "both measured requests finish");
  assert(maximum === (reentrant ? 2 : 1), "event order proves the declared queue behavior");
}

function lifecycleCases(rust: boolean): ConformanceCase[] {
  const names = rust
    ? { good: "rust-good", slow: "rust-slow", crasher: "rust-crasher" } as const
    : { good: "good", slow: "slow", crasher: "crasher" } as const;
  const ids = { good: `fx-${names.good}`, slow: `fx-${names.slow}`, crasher: `fx-${names.crasher}`, claims: rust ? "fx-rust-claims" : "fx-claims" };
  const cases: ConformanceCase[] = [
    { name: "handshake checks identity, protocol major and served points", async run(t) {
      if (rust) t.install(names.good, { manifest: { id: ids.claims }, fixture: { claimContributes: ["diagnostic", "usage"] } });
      else t.install("claims");
      t.install(names.good, { manifest: { version: "9.9.9" } });
      const h = await t.host();
      await h.call("plugin.enable", { id: ids.claims, grant: true });
      const r = await doctor(h, ids.claims);
      assert(r.ok && r.served.join() === "diagnostic", `a claimed point the manifest lacks is not served (got ${r.served.join()})`);
      assert((await listed(h))[ids.good]?.version === "9.9.9", "the listing shows the manifest version");
    } },
    { name: "lazy start: list starts nothing, doctor starts the process", async run(t) {
      t.install(names.good);
      const h = await t.host();
      await h.call("plugin.enable", { id: ids.good, grant: true });
      assert((await listed(h))[ids.good]?.pid === null, "no pid before the first call");
      const r = await doctor(h, ids.good);
      assert(r.ok && r.pid !== null && alive(r.pid), "doctor starts the plugin and reports its pid");
      assert((await listed(h))[ids.good]?.state === "ready", "the plugin is ready after the first call");
    } },
    { name: "deadline: plugin_timeout, the process survives, a later ping works", async run(t) {
      t.install(names.slow);
      const h = await t.host();
      await h.call("plugin.enable", { id: ids.slow, grant: true });
      const t0 = Date.now(), first = await doctor(h, ids.slow);
      assert(!first.ok && /^plugin_timeout/.test(first.error ?? ""), `the slow ping reports plugin_timeout (got ${first.error})`);
      assert(Date.now() - t0 >= 4500 && Date.now() - t0 < 8000, "the deadline is about 5 s");
      assert(first.pid !== null && alive(first.pid), "the process survives a timeout");
      const second = await doctor(h, ids.slow);
      assert(second.ok && second.pid === first.pid, "a later ping on the same process works");
    } },
    { name: "crash and backoff: restarts, then failing after three crashes, enable clears", async run(t) {
      t.install(names.crasher);
      const h = await t.host();
      await h.call("plugin.enable", { id: ids.crasher, grant: true });
      const pids: number[] = [];
      for (let i = 0; i < 3; i++) { const r = await doctor(h, ids.crasher); assert(r.ok, `ping ${i + 1} works before the crash`); pids.push(r.pid!); await t.sleep(250); }
      assert(new Set(pids).size === 3, "each restart is a new process");
      const failing = await doctor(h, ids.crasher);
      assert(!failing.ok && failing.state === "failing" && failing.restarts === 3 && /3 failures within a minute/.test(failing.error ?? ""), `three crashes within a minute mark the plugin failing (got ${failing.state}: ${failing.error})`);
      assert(await eventually(() => h.events.some(e => e.type === "plugin" && (e.data as { state: string }).state === "failing")), "a plugin event announces the failing state");
      const states = h.events
        .filter(e => e.type === "plugin" && (e.data as { id: string }).id === ids.crasher)
        .map(e => (e.data as { state: string }).state);
      assert(states.at(-1) === "failing", "the last event for the crashed plugin is failing");
      const after = await h.call<{ state: string }>("plugin.enable", { id: ids.crasher, grant: true });
      assert(after.state === "idle", "enable clears failing");
      assert((await doctor(h, ids.crasher)).ok, "the plugin runs again after enable");
    } },
  ];
  return cases.map(c => ({ ...c, name: c.name + (rust ? " (rust)" : "") }));
}

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
  ...lifecycleCases(false),
  ...lifecycleCases(true),
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
    t.install("serial", { fixture: { pingProbe: "serial" } });
    t.install("reentrant", { fixture: { pingProbe: "barrier" } });
    const h = await t.host();
    for (const id of ["fx-serial", "fx-reentrant"]) {
      await h.call("plugin.enable", { id, grant: true });
      const warmup = await doctor(h, id);
      assert(warmup.ok && warmup.pid !== null, `${id} warmup succeeds`);
      const reports = await Promise.all([doctor(h, id), doctor(h, id)]);
      assert(reports.every(report => report.ok && report.pid === warmup.pid), `${id} both measured calls finish on the warmed process (got ${reports.map(report => report.error).join()})`);
      const receipts = readFileSync(join(t.pluginsDir, id, "ping-receipts.jsonl"), "utf8");
      assertPingReceipts(receipts, id === "fx-reentrant");
    }
    const log = (id: string) => readFileSync(join(t.home, ".pacer", "logs", "plugins", `${id}.log`), "utf8");
    assert(await eventually(() => ["fx-serial", "fx-reentrant"].every(id => log(id).includes("ping 3"))), "both measured ping logs arrive");
    assert(!log("fx-serial").includes("active pings 2"), "non-reentrant pings run one at a time");
    assert(await eventually(() => log("fx-reentrant").includes("active pings 2")), "reentrant pings overlap");
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
