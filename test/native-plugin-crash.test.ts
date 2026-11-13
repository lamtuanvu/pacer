import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { hostSocketCheck } from "../src/install/host-socket-check";
import { pluginNativeRequest } from "../src/serve/plugin-native";
import { fakeCtx } from "./helpers";
import { alive, front, makeHome, normalize, ownerOn, semantic, serve, spawnServe, stdio, tsOwner, type Home, type Reply } from "./native-plugin-door";

// Crash reporting, restart backoff, stop escalation and one serve per home (ADR 0027, OD-7)
// on the native front door, against the TypeScript owner as the golden.

const context = { route: "overview", theme: "light" };
const hold = { plugin: "fx-ui", surface: "activity", id: "checklist", context, action: "hold", requestId: "hold" };

/** A fixture child that logs each start with its time, can hold an action open, and may ignore SIGTERM. */
function crashMain(h: Home, stubborn = false) {
  writeFileSync(join(h.plugin, "main.ts"), `#!/usr/bin/env bun
import {serve,stdinLines} from '@pacer/plugin';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
appendFileSync('starts', process.pid + ' ' + Date.now() + '\\n');
${stubborn ? "process.on('SIGTERM',()=>appendFileSync('sigterm',process.pid+' '+Date.now()+'\\n'));" : ""}
const manifest=JSON.parse(readFileSync(new URL('./pacer-plugin.json',import.meta.url),'utf8'));
await serve({manifest,input:stdinLines(),handlers:{'ui.action':async p=>{
 if(p.action==='hold'){writeFileSync('held',String(process.pid));await new Promise(()=>{});}
 return {result:'done'};
}}});`);
}

/** `[pid, at]` for each line of a fixture log: every start, or every SIGTERM a stubborn child ignored. */
const timeLog = (h: Home, name: string): [number, number][] => existsSync(join(h.plugin, name))
  ? readFileSync(join(h.plugin, name), "utf8").trim().split("\n").map(line => line.split(" ").map(Number) as [number, number])
  : [];
const startLog = (h: Home) => timeLog(h, "starts");

/** Start a `hold` action and wait until the child holds it; returns the child's pid. */
async function holdAction(h: Home, call: (op: string, params: unknown) => Promise<Reply>) {
  void call("plugin.ui.action", hold).catch(() => undefined);
  for (let i = 0; i < 1000 && !existsSync(join(h.plugin, "held")); i++) await Bun.sleep(10);
  return Number(readFileSync(join(h.plugin, "held"), "utf8"));
}

/** The door stopped within the grace, SIGTERM reached the child at once, and nothing of the home is left running. */
async function stoppedPromptly(h: Home, pid: number, stoppingAt: number, exited: Promise<number>, label: string) {
  await exited;
  const took = Date.now() - stoppingAt;
  const [[termed, termedAt]] = timeLog(h, "sigterm");
  expect(termed, label).toBe(pid);
  expect(termedAt - stoppingAt, `${label}: SIGTERM delay`).toBeLessThan(1000);
  expect(took, `${label}: exit`).toBeGreaterThanOrEqual(1900);
  expect(took, `${label}: exit`).toBeLessThan(5000);
  expect(alive(pid)).toBe(false);
  expect(homeProcesses(h)).toEqual([]);
}

async function gone(pid: number, within = 5000) {
  for (let i = 0; i < within / 10 && alive(pid); i++) await Bun.sleep(10);
  expect(alive(pid)).toBe(false);
}

/** Kill the newest child and wait until this door's Core has recorded the crash. */
async function crash(h: Home, call: (op: string, params: unknown) => Promise<Reply>) {
  const [pid] = startLog(h).at(-1)!;
  const at = Date.now();
  process.kill(pid, "SIGKILL");
  await gone(pid);
  for (let i = 0; i < 500; i++) {
    const entry = (await call("plugin.list", {})).json.result.plugins.find((p: any) => p.id === "fx-ui");
    if (entry.state !== "ready") break;
    await Bun.sleep(10);
  }
  return at;
}

/** Process ids whose argv names this home: plugin children and their wrappers. */
function homeProcesses(h: Home): number[] {
  const out = Bun.spawnSync(["pgrep", "-f", h.home]).stdout.toString().trim();
  return out ? out.split("\n").map(Number) : [];
}

test("Core records a native owner's crash report as its own exit, and only with the owner on", async () => {
  const h = makeHome();
  try {
    const env = { PATH: process.env.PATH! };
    const off = fakeCtx({ home: h.home, pacerHome: h.state, env });
    const on = fakeCtx({ home: h.home, pacerHome: h.state, env: { ...env, PACER_HOST_SOCKET: join(h.state, "run", "host.sock") } });
    await callOp(off, "plugin.enable", { id: "fx-ui", grant: true });
    const crashed = (ctx: typeof on, reason: string, relay = false) => pluginNativeRequest(ctx, { kind: "crashed", id: "fx-ui", reason }, { relay }) as Promise<any>;
    // Flag-off the registry watches its own children; a report could only be forged.
    expect((await crashed(off, "exited on SIGKILL")).error).toMatchObject({ code: "plugin_unavailable", message: "crash reports require the native process owner" });
    // A stdio Core attached to the service's `host.sock` does not own the children it would report.
    expect((await crashed(on, "exited on SIGKILL", true)).error).toMatchObject({ code: "plugin_unavailable", message: "crash reports go to the Core of the door that owns the plugin" });
    for (const reason of ["exited on SIGKILL; 3 failures within a minute", "killed", "exited with code x", ""]) {
      expect((await crashed(on, reason)).error, reason).toMatchObject({ code: "invalid_input" });
    }
    const fx = (reply: any) => reply.entries.find((e: any) => e.id === "fx-ui");
    const before = Date.now();
    // An owning stdio connection reports over its own connection socket.
    const owning = fakeCtx({ home: h.home, pacerHome: h.state, env: { ...env, PACER_HOST_SOCKET: join(h.state, "run", "s0123456789ab.sock") } });
    expect(fx(await crashed(owning, "exited with code 3", true))).toMatchObject({ state: "idle", restarts: 1, error: "exited with code 3" });
    const spec = (await pluginNativeRequest(on, { kind: "spawn_spec", id: "fx-ui" }) as any).value;
    // The door reports `ready` for a child it finds ready only while Core lists it otherwise.
    expect(spec.state).toBe("idle");
    expect(spec.nextStartAt).toBeGreaterThanOrEqual(before + 1000);
    expect(spec.nextStartAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(fx(await crashed(on, "exited on SIGKILL"))).toMatchObject({ state: "idle", restarts: 2 });
    expect(fx(await crashed(on, "exited on SIGKILL"))).toMatchObject({ state: "failing", restarts: 3, error: "exited on SIGKILL; 3 failures within a minute" });
    // A failing plugin takes no more reports until it is enabled again.
    expect(fx(await crashed(on, "exited on SIGKILL"))).toMatchObject({ state: "failing", restarts: 3 });
    expect((await pluginNativeRequest(on, { kind: "spawn_spec", id: "fx-ui" }) as any).error).toBeDefined();
  } finally { h.done(); }
});

test.skipIf(!front)("a crash mid-call fails that call as plugin_unavailable naming the plugin", async () => {
  const errors: Record<string, any> = {};
  for (const [name, options] of [["typescript", tsOwner], ["native", ownerOn]] as const) {
    const h = makeHome();
    crashMain(h);
    const service = await serve(h, "", options);
    try {
      await service.call("plugin.enable", { id: "fx-ui", grant: true });
      const pending = service.call("plugin.ui.action", hold);
      for (let i = 0; i < 1000 && !existsSync(join(h.plugin, "held")); i++) await Bun.sleep(10);
      process.kill(Number(readFileSync(join(h.plugin, "held"), "utf8")), "SIGKILL");
      errors[name] = semantic(await pending);
      // The next call is served by a new child once the backoff passes.
      expect((await service.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0]).toMatchObject({ ok: true, restarts: 1 });
      expect(startLog(h)).toHaveLength(2);
    } finally { await service.stop(); h.done(); }
  }
  // TypeScript reports whichever it sees first (`plugin stdout closed` or the exit); the owner waits for the exit.
  expect(errors.typescript).toMatchObject({ code: "plugin_unavailable", message: expect.stringMatching(/^ui\.action: plugin /) });
  expect(errors.native).toEqual({ code: "plugin_unavailable", message: "ui.action: plugin fx-ui exited on SIGKILL" });
}, 90000);

test.skipIf(!front)("restarts wait out the sealed backoff, three crashes mark failing as TypeScript does, and enable recovers", async () => {
  const runs: Record<string, { h: Home; doctors: string[] }> = {};
  try {
    for (const [name, options] of [["typescript", tsOwner], ["native", ownerOn]] as const) {
      const h = makeHome();
      crashMain(h);
      const doctors: string[] = [];
      runs[name] = { h, doctors };
      const service = await serve(h, "", options);
      try {
        await service.call("plugin.enable", { id: "fx-ui", grant: true });
        const doctor = async () => {
          const reply = await service.call("plugin.doctor", { id: "fx-ui" });
          // Core's snapshot does not know an owner-supervised child's pid.
          doctors.push(normalize(h, reply.text).replaceAll('"pid":null', '"pid":0'));
          return reply.json.result.reports[0];
        };
        expect(await doctor()).toMatchObject({ ok: true, restarts: 0 });
        for (const [n, backoff] of [[1, 1000], [2, 2000]] as const) {
          const killedAt = await crash(h, service.call);
          expect(await doctor()).toMatchObject({ ok: true, restarts: n });
          const [, startedAt] = startLog(h).at(-1)!;
          expect(startedAt - killedAt, `${name} restart ${n}`).toBeGreaterThanOrEqual(backoff);
        }
        await crash(h, service.call);
        expect(await doctor()).toMatchObject({ ok: false, state: "failing", restarts: 3, error: "exited on SIGKILL; 3 failures within a minute" });
        expect(startLog(h)).toHaveLength(3);
        // Enabling again clears Core's backoff and the owner's restart floor.
        const enabledAt = Date.now();
        await service.call("plugin.enable", { id: "fx-ui", grant: true });
        expect(await doctor()).toMatchObject({ ok: true, restarts: 0 });
        expect(startLog(h).at(-1)![1] - enabledAt, `${name} recovery`).toBeLessThan(1000);
      } finally { await service.stop(); }
    }
    expect(runs.native.doctors).toEqual(runs.typescript.doctors);
  } finally { for (const run of Object.values(runs)) run.h.done(); }
}, 120000);

test.skipIf(!front)("an attached stdio connection cannot respawn a crashing child faster than the owner's floor", async () => {
  const h = makeHome();
  crashMain(h);
  const service = await serve(h, "", ownerOn);
  const s = await stdio(h, "", ownerOn);
  try {
    await service.call("plugin.enable", { id: "fx-ui", grant: true });
    expect((await s.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    const [[pid]] = startLog(h);
    const killedAt = Date.now();
    process.kill(pid, "SIGKILL");
    await gone(pid);
    // The attached Core never hears of the crash, so it seals no backoff of its own.
    let report: any;
    for (let i = 0; i < 20; i++) {
      report = (await s.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0];
      if (report.ok) break;
      expect(report.error).toBe("plugin_unavailable: diagnostic.ping: plugin fx-ui exited on SIGKILL");
    }
    expect(report.ok).toBe(true);
    expect(startLog(h)).toHaveLength(2);
    expect(startLog(h)[1][1] - killedAt).toBeGreaterThanOrEqual(1000);
    // The serve's own Core heard it from its owner.
    expect((await service.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].restarts).toBe(1);
  } finally {
    const log = await s.stop();
    expect(log).toMatch(/^native plugin owner attach /m);
    await service.stop(); h.done();
  }
}, 90000);

test.skipIf(!front)("an attached stdio connection cannot restart a plugin the service marked failing", async () => {
  const h = makeHome();
  crashMain(h);
  const service = await serve(h, "", ownerOn);
  const s = await stdio(h, "", ownerOn);
  const doctor = async (call: (op: string, params: unknown) => Promise<Reply>) => (await call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0];
  try {
    await service.call("plugin.enable", { id: "fx-ui", grant: true });
    expect((await doctor(service.call)).ok).toBe(true);
    for (const n of [1, 2]) {
      await crash(h, service.call);
      expect(await doctor(service.call)).toMatchObject({ ok: true, restarts: n });
    }
    await crash(h, service.call);
    expect(await doctor(service.call)).toMatchObject({ ok: false, state: "failing", restarts: 3 });
    // The attached Core never heard of the crashes; past the third floor (4 s) the owner still refuses.
    let report: any;
    for (const until = Date.now() + 5000; Date.now() < until; await Bun.sleep(250)) {
      report = await doctor(s.call);
      expect(report.ok).toBe(false);
    }
    expect(report.error).toContain("plugin fx-ui is failing: 3 failures within a minute");
    expect(startLog(h)).toHaveLength(3);
    // Enabling through the service clears the owner's mark, and the attached door is served again.
    await service.call("plugin.enable", { id: "fx-ui", grant: true });
    expect((await doctor(s.call)).ok).toBe(true);
    expect(startLog(h)).toHaveLength(4);
  } finally {
    await s.stop();
    await service.stop(); h.done();
  }
}, 90000);

test.skipIf(!front)("serve shutdown escalates to SIGKILL and leaves no plugin child behind", async () => {
  const h = makeHome();
  crashMain(h, true);
  const service = await serve(h, "", ownerOn);
  let pid = 0;
  try {
    await service.call("plugin.enable", { id: "fx-ui", grant: true });
    expect((await service.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    [[pid]] = startLog(h);
    expect(homeProcesses(h)).toContain(pid);
    const stoppingAt = Date.now();
    service.child.kill("SIGTERM");
    await service.child.exited;
    const took = Date.now() - stoppingAt;
    // The child logged SIGTERM and lived through it until the 2 s grace ran out.
    expect(timeLog(h, "sigterm").map(([termed]) => termed)).toEqual([pid]);
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(alive(pid)).toBe(false);
    expect(homeProcesses(h)).toEqual([]);
    for (const name of ["host.sock", "host.sock.pid"]) expect(existsSync(join(h.state, "run", name))).toBe(false);
  } finally { await service.stop(); if (pid && alive(pid)) process.kill(pid, "SIGKILL"); h.done(); }
}, 60000);

test.skipIf(!front)("an owning stdio connection stops its children with escalation on EOF and on SIGTERM", async () => {
  for (const end of ["eof", "sigterm"] as const) {
    const h = makeHome();
    crashMain(h, true);
    const s = await stdio(h, "", ownerOn);
    let pid = 0;
    try {
      await s.call("plugin.enable", { id: "fx-ui", grant: true });
      expect((await s.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
      [[pid]] = startLog(h);
      const stoppingAt = Date.now();
      if (end === "eof") s.child.stdin.end(); else s.child.kill("SIGTERM");
      await s.child.exited;
      expect(Date.now() - stoppingAt, end).toBeGreaterThanOrEqual(1900);
      expect(timeLog(h, "sigterm").map(([termed]) => termed)).toEqual([pid]);
      expect(alive(pid)).toBe(false);
      expect(homeProcesses(h)).toEqual([]);
    } finally { await s.stop().catch(() => ""); if (pid && alive(pid)) process.kill(pid, "SIGKILL"); h.done(); }
  }
}, 90000);

// A call holds its plugin for up to 30 s; stopping must not wait for it.
test.skipIf(!front)("serve shutdown with a plugin call in flight stops the child at once and exits within the grace", async () => {
  const h = makeHome();
  crashMain(h, true);
  const service = await serve(h, "", ownerOn);
  let pid = 0;
  try {
    await service.call("plugin.enable", { id: "fx-ui", grant: true });
    pid = await holdAction(h, service.call);
    const stoppingAt = Date.now();
    service.child.kill("SIGTERM");
    await stoppedPromptly(h, pid, stoppingAt, service.child.exited, "serve");
    for (const name of ["host.sock", "host.sock.pid"]) expect(existsSync(join(h.state, "run", name))).toBe(false);
  } finally { await service.stop(); if (pid && alive(pid)) process.kill(pid, "SIGKILL"); h.done(); }
}, 60000);

test.skipIf(!front)("an owning stdio connection terminated with a plugin call in flight stops the child at once", async () => {
  const h = makeHome();
  crashMain(h, true);
  const s = await stdio(h, "", ownerOn);
  let pid = 0;
  try {
    await s.call("plugin.enable", { id: "fx-ui", grant: true });
    pid = await holdAction(h, s.call);
    const stoppingAt = Date.now();
    s.child.kill("SIGTERM");
    await stoppedPromptly(h, pid, stoppingAt, s.child.exited, "stdio");
  } finally { await s.stop().catch(() => ""); if (pid && alive(pid)) process.kill(pid, "SIGKILL"); h.done(); }
}, 60000);

test.skipIf(!front)("a second serve on a live home exits 3 after a bounded wait, and doctor names the owner", async () => {
  const h = makeHome();
  const first = await serve(h, "", ownerOn);
  const socket = join(h.state, "run", "host.sock");
  try {
    expect(readFileSync(join(h.state, "run", "host.sock.pid"), "utf8").trim()).toBe(String(first.child.pid));
    expect(await hostSocketCheck(fakeCtx({ home: h.home, pacerHome: h.state }))).toEqual({ name: "Plugin host socket", level: "info",
      detail: `${socket} is live (owner pid ${first.child.pid}); another pacer serve on this home exits 3 until it stops. Stop the owner (pacer service stop) or wait for it to exit.` });
    const startedAt = Date.now();
    const second = spawnServe(h, "", { ...ownerOn, env: { PACER_SERVE_OWNER_WAIT_MS: "600" } });
    expect(await second.child.exited).toBe(3);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600);
    const log = await second.logs;
    expect(log).toContain(`pacer: serve: the plugin host socket at ${socket} is live; waiting up to 600 ms for its owner to exit`);
    expect(log).toContain(`another pacer owns the plugin host socket at ${socket} (pid ${first.child.pid}): stop the other pacer (pacer service stop) or wait for it to exit`);
    // The first serve is untouched.
    expect((await first.call("plugin.list", {})).json.result.plugins.length).toBeGreaterThan(0);
  } finally { await first.stop(); h.done(); }
}, 60000);

/** Wait until `serve` answers hello on its port. */
async function up(h: Home, port: number, child: { exitCode: number | null }) {
  for (let i = 0; i < 500 && child.exitCode === null; i++) {
    try {
      const token = readFileSync(join(h.state, "token"), "utf8").trim();
      if ((await fetch(`http://127.0.0.1:${port}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok) return true;
    } catch { /* not yet */ }
    await Bun.sleep(20);
  }
  return false;
}

test.skipIf(!front)("a serve started while the owner is exiting takes over once it is gone", async () => {
  const h = makeHome();
  const first = await serve(h, "", ownerOn);
  const waiting = spawnServe(h, "", { ...ownerOn, env: { PACER_SERVE_OWNER_WAIT_MS: "20000" } });
  try {
    for (let i = 0; i < 1000 && !waiting.stderr().includes("waiting up to 20000 ms"); i++) await Bun.sleep(10);
    expect(waiting.stderr()).toContain("waiting up to 20000 ms for its owner to exit");
    await first.stop();
    expect(await up(h, waiting.port, waiting.child)).toBe(true);
    expect(readFileSync(join(h.state, "run", "host.sock.pid"), "utf8").trim()).toBe(String(waiting.child.pid));
  } finally {
    await first.stop();
    waiting.child.kill("SIGTERM");
    expect(await waiting.child.exited).toBe(0);
    expect(await waiting.logs).not.toContain("another pacer owns");
    h.done();
  }
}, 60000);

test.skipIf(!front)("a killed owner's socket is reported stale and replaced without waiting", async () => {
  const h = makeHome();
  const socket = join(h.state, "run", "host.sock");
  const ctx = fakeCtx({ home: h.home, pacerHome: h.state });
  try {
    const killed = await serve(h, "", ownerOn);
    killed.child.kill("SIGKILL");
    await killed.child.exited;
    expect(existsSync(socket)).toBe(true);
    expect(await hostSocketCheck(ctx)).toEqual({ name: "Plugin host socket", level: "info", detail: `${socket} is stale; the next pacer serve replaces it` });
    const startedAt = Date.now();
    const next = spawnServe(h, "", { ...ownerOn, env: { PACER_SERVE_OWNER_WAIT_MS: "20000" } });
    try {
      expect(await up(h, next.port, next.child)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(15000);
      expect(next.stderr()).not.toContain("waiting up to");
      expect((await hostSocketCheck(ctx))?.detail).toContain(`(owner pid ${next.child.pid})`);
    } finally { next.child.kill("SIGTERM"); await next.child.exited; }
    expect(existsSync(socket)).toBe(false);
    expect(await hostSocketCheck(ctx)).toBeNull();
  } finally { h.done(); }
}, 60000);
