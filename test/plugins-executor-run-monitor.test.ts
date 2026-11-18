import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { type ProviderCfg, loadStrategy } from "../src/config/strategy";
import { sendMessage } from "../src/messaging/send";
import * as store from "../src/messaging/store";
import { idleStopOutcome, retryLoopOutcome, runOwnedDirectCurrent } from "../src/plugins/executor-production";
import { startRunMonitor } from "../src/plugins/executor-run-monitor";
import { FrameType, wire } from "../src/session/framing";
import { Recording } from "../src/session/recording";
import { ViewerHub } from "../src/session/viewers";
import { readRun, startRun, stopRun } from "../src/supervisor/run";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { RunRef } from "../src/tasks/types";
import { fakeCtx, realRun, tmpDir } from "./helpers";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function waitFor(what: string, done: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !done(); await Bun.sleep(20)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

/** A live owned local run the plugin started (its start intent is persisted), with no output. */
async function ownedRun(o: {env?: Record<string, string>; interactive?: boolean; started?: boolean; argv?: string[]} = {}) {
  const ctx = fakeCtx({env: o.env ?? {}}), dir = tmpDir();
  const launched = startRun({dir, argv: o.argv ?? ["sh", "-c", "exec sleep 30"], cwd: dir, env: {PATH: process.env.PATH}});
  if ("error" in launched) throw new Error(launched.error);
  await waitFor("the run to start", () => readRun(dir).alive);
  if (o.interactive) writeFileSync(join(dir, "interactive.json"), JSON.stringify({reportToken: "x"}));
  const task = createTask(ctx, {brief: {goal: "watch", repo: dir}, kind: null, requestedExecutor: null, timeoutS: 600});
  const run: RunRef = {dir, attempt: 1, executor: "claude-code", startedAt: Date.now() / 1000, mode: "current", workdir: dir, logFile: join(dir, "log"),
    ...(o.interactive ? {session: "interactive" as const} : {})};
  updateTask(ctx, task.id, t => {
    t.state = "running"; t.run = run; t.executorProvider = "pacer-exec-direct"; t.executor = "claude-code"; t.origin = "external:claude-code"; t.attempts = [];
    if (o.started !== false) t.startIntent = {attempt: 1, providerId: "pacer-exec-direct", dir};
  });
  return {ctx, id: task.id, dir, run, close: () => stopRun(dir, {graceMs: 500})};
}

/** The plugin's executor.run call: pending until the run exits. */
const pendingCall = (dir: string) => (async () => { await waitFor("the run to exit", () => readRun(dir).exit !== null, 30_000); return "settled"; })();

test("writes task progress while the plugin call is pending", async () => {
  const r = await ownedRun();
  const seeded = r.run.startedAt - 100;
  updateTask(r.ctx, r.id, t => { t.progress = {phase: "starting", lastOutputAt: null, lastChangeAt: null, files: 0, commits: 0, logBytes: 0, host: "local", updatedAt: seeded}; });
  const monitor = startRunMonitor(r.ctx, r.id, r.dir, {pollMs: 50});
  try {
    await waitFor("a progress write", () => (readTask(r.ctx, r.id)!.progress?.updatedAt ?? 0) > seeded);
    expect(["working", "starting"]).toContain(readTask(r.ctx, r.id)!.progress!.phase);
  } finally { await monitor.stop(); await r.close(); }
}, 15_000);

test("writes nothing before the plugin has started the claimed run", async () => {
  // The plugin starts its claimed run under the claim's task revision, so an earlier task write would refuse the launch.
  const r = await ownedRun({started: false});
  const monitor = startRunMonitor(r.ctx, r.id, r.dir, {pollMs: 20});
  try {
    const rev = readTask(r.ctx, r.id)!.rev;
    await Bun.sleep(200);
    expect(readTask(r.ctx, r.id)!.rev).toBe(rev);
    updateTask(r.ctx, r.id, t => { t.startIntent = {attempt: 1, providerId: "pacer-exec-direct", dir: r.dir}; });
    await waitFor("a progress write", () => !!readTask(r.ctx, r.id)!.progress);
  } finally { await monitor.stop(); await r.close(); }
}, 15_000);

test("stops an idle run after idle_fail and the outcome reports idle", async () => {
  // PACER_IDLE_SCALE 0.001: idle_fail is 1.8 s.
  const r = await ownedRun({env: {PACER_IDLE_SCALE: "0.001"}});
  const call = pendingCall(r.dir), monitor = startRunMonitor(r.ctx, r.id, r.dir, {pollMs: 50});
  try {
    expect(await call).toBe("settled");
    await monitor.stop();
    // The verdict is on the task record, so an outcome read after a service restart still sees it.
    expect(readTask(r.ctx, r.id)!.run!.retryBanner?.ended).toBe("idle");
    const out = {exec: {code: 0, stdout: "", stderr: "", timedOut: false}, report: "partial", attempt: {limitHit: false, exitCode: 0}};
    expect(idleStopOutcome(r.ctx, r.id, r.dir, out)).toBe(true);
    expect(out.exec.code).toBe(1);
    expect(out.attempt.exitCode).toBe(1);
    expect(out.report).toContain("pacer: stopped after 30 min without output or file changes");
    expect(out.exec.stderr).toContain("pacer: stopped after 30 min without output or file changes");
    // A completed report outranks the idle stop.
    writeFileSync(join(r.dir, "interactive.json"), "{}");
    writeFileSync(join(r.dir, "report.json"), JSON.stringify({status: "done", summary: "Finished", source: "agent", at: Date.now() / 1000}));
    const reported = {exec: {code: 0, stderr: "", timedOut: false}, report: "", attempt: {limitHit: false, exitCode: 0}};
    expect(idleStopOutcome(r.ctx, r.id, r.dir, reported)).toBe(false);
    expect(reported.exec.code).toBe(0);
  } finally { await monitor.stop(); await r.close(); }
}, 15_000);

/** A session socket served by the real viewer hub, recording what reaches the PTY. */
function fakeSession(dir: string) {
  const sock = join(mkdtempSync("/tmp/pl-"), "s.sock");
  writeFileSync(join(dir, "session.sock.path"), sock);
  const input: Buffer[] = [];
  const published = (viewers: number, controller: string | null) =>
    writeFileSync(join(dir, "session.state"), JSON.stringify({viewers, controller, cols: 120, rows: 40}));
  const hub = new ViewerHub(() => wire(FrameType.snapshot, {}), () => null, fn => fn(), () => {}, published,
    {input: b => { input.push(Buffer.from(b)); }, resize() {}, release() {}});
  const server = createServer(s => hub.add(s));
  servers.push(server);
  return {ready: new Promise<void>(res => server.listen(sock, res)), input};
}

test("delivers a pending message to a live interactive session", async () => {
  const r = await ownedRun({interactive: true});
  const at = Date.now() / 1000;
  writeFileSync(join(r.dir, "session-status.json"), JSON.stringify({status: "turn-ended", summary: "s", at}));
  utimesSync(join(r.dir, "session-status.json"), at, at);
  const session = fakeSession(r.dir);
  await session.ready;
  expect((await sendMessage(r.ctx, {to: `task:${r.id}`, body: "please also check Y"}, {appAuthenticated: true})).delivery).toBe("live");
  const monitor = startRunMonitor(r.ctx, r.id, r.dir, {pollMs: 50});
  try {
    await waitFor("the live delivery", () => Buffer.concat(session.input).toString().includes("please also check Y"));
    expect(store.pendingFor(r.ctx, `task:${r.id}`).length).toBe(0);
  } finally { await monitor.stop(); await r.close(); }
}, 15_000);

test("an animating rate-limit banner is stopped within one poll, not one lease", async () => {
  const ctx = fakeCtx(), dir = tmpDir();
  const launched = startRun({dir, argv: ["sh", "-c", "exec sleep 30"], cwd: dir, env: {PATH: process.env.PATH}});
  if ("error" in launched) throw new Error(launched.error);
  await waitFor("the run to start", () => readRun(dir).alive);
  writeFileSync(join(dir, "interactive.json"), "{}");
  const recording = new Recording(dir);
  await recording.output(readFileSync(join(import.meta.dir, "fixtures", "opencode-retry-ratelimit.ansi")));
  const task = createTask(ctx, {brief: {goal: "retry", repo: dir}, kind: null, requestedExecutor: null, timeoutS: 7200});
  const run: RunRef = {dir, attempt: 1, executor: "opencode#tse", startedAt: Date.now() / 1000 - 60, mode: "current", workdir: dir, logFile: join(dir, "log"), session: "interactive"};
  updateTask(ctx, task.id, t => { t.state = "running"; t.run = run; t.executorProvider = "pacer-exec-direct"; t.startIntent = {attempt: 1, providerId: "pacer-exec-direct", dir}; });
  const began = Date.now(), monitor = startRunMonitor(ctx, task.id, run, {pollMs: 50});
  try {
    await waitFor("the banner stop", () => readRun(dir).exit !== null);
    expect(Date.now() - began).toBeLessThan(60_000);
    expect(readTask(ctx, task.id)!.run!.retryBanner).toMatchObject({ended: "limit", reason: expect.stringContaining("Rate limit exceeded")});
    const out = {exec: {code: 143, stdout: "", stderr: "", timedOut: false}, report: "", attempt: {limitHit: false, exitCode: 143} as {limitHit: boolean; exitCode: number; brokenReason?: string}};
    expect(retryLoopOutcome(ctx, task.id, run.executor, dir, out)).toBe(true);
    expect(out.attempt.limitHit).toBe(true);
  } finally { await monitor.stop(); await recording.close(); await stopRun(dir, {graceMs: 500}); }
}, 15_000);

test("a monitor error never fails the attempt", async () => {
  let ticks = 0;
  for (const poller of [
    () => { ticks++; throw new Error("poller construction failed"); },
    () => async () => { ticks++; throw new Error("poll failed"); },
  ]) {
    const r = await ownedRun();
    ticks = 0;
    const monitor = startRunMonitor(r.ctx, r.id, r.dir, {pollMs: 20, poller});
    try {
      await waitFor("several failing ticks", () => ticks >= 3);
      setTimeout(() => { void r.close(); }, 50);
      expect(await pendingCall(r.dir)).toBe("settled");
      await monitor.stop();
    } finally { await monitor.stop(); await r.close(); }
  }
}, 20_000);

test("stop() ends polling, and so does the run's exit", async () => {
  const r = await ownedRun();
  let polls = 0;
  const counting = () => async () => { polls++; return "continue" as const; };
  const monitor = startRunMonitor(r.ctx, r.id, r.dir, {pollMs: 20, poller: counting});
  try {
    await waitFor("a few polls", () => polls >= 2);
    await monitor.stop();
    const after = polls;
    await Bun.sleep(150);
    expect(polls).toBe(after);
  } finally { await monitor.stop(); }
  // A run that exited ends the monitor on its own.
  const ended = startRunMonitor(r.ctx, r.id, r.dir, {pollMs: 20, poller: counting});
  await r.close();
  const before = polls;
  await Bun.sleep(150);
  expect(polls - before).toBeLessThanOrEqual(1);
  await ended.stop();
}, 15_000);

function directFixture(script: string, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpDir(), "direct-"));
  const pacerHome = join(home, ".pacer"), repo = join(home, "repo"), bin = join(home, "bin");
  for (const d of [pacerHome, repo, bin]) mkdirSync(d, {mode: 0o700});
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: current, launch_mode: headless}\n", {mode: 0o600});
  const executable = join(bin, "codex");
  writeFileSync(executable, `#!/bin/sh\n${script}\n`, {mode: 0o700});
  chmodSync(executable, 0o700);
  const ctx = fakeCtx({home, pacerHome, env: {PATH: `${bin}:${process.env.PATH}`, ...env}, which: name => name === "codex" ? executable : null});
  const created = createTask(ctx, {brief: {goal: "fixture", repo}, kind: null, requestedExecutor: "codex", timeoutS: 60, placement: {requested: "current"}});
  const task = updateTask(ctx, created.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
  return {ctx, task, cfg: loadStrategy(ctx).providers.codex as ProviderCfg, cleanup: () => rmSync(home, {recursive: true, force: true})};
}

test("the bundled direct provider stops an idle headless attempt and fails it as idle", async () => {
  const f = directFixture("exec sleep 30", {PACER_IDLE_SCALE: "0.001"});
  try {
    const out = await runOwnedDirectCurrent(f.ctx, f.cfg, f.task);
    expect(out.exec.code).not.toBe(0);
    expect(out.attempt.exitCode).toBe(out.exec.code);
    expect(out.report).toContain("pacer: stopped after 30 min without output or file changes");
    expect(readTask(f.ctx, f.task.id)!.progress).toBeDefined();
    expect(readTask(f.ctx, f.task.id)!.executorExitReceipt).toMatchObject({attempt: 1, exitCode: out.exec.code});
  } finally { f.cleanup(); }
}, 20_000);

test("the bundled direct provider leaves a finished headless attempt alone", async () => {
  const f = directFixture("printf 'owned provider result\\n'", {PACER_IDLE_SCALE: "0.001"});
  try {
    const out = await runOwnedDirectCurrent(f.ctx, f.cfg, f.task);
    expect(out.exec.code).toBe(0);
    expect(out.report).not.toContain("without output or file changes");
  } finally { f.cleanup(); }
}, 20_000);

test("the bundled direct provider stops an idle interactive attempt within its lease and fails it as idle", async () => {
  const f = directFixture('if [ "$1" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nexec sleep 30', {PACER_IDLE_SCALE: "0.001"});
  try {
    const began = Date.now();
    const out = await runOwnedDirectCurrent({...f.ctx, run: realRun}, {...f.cfg, session: "interactive"}, f.task);
    expect(Date.now() - began).toBeLessThan(30_000);
    expect(readTask(f.ctx, f.task.id)!.run!.session).toBe("interactive");
    expect(out.exec.code).not.toBe(0);
    expect(out.attempt.limitHit).toBe(false);
    expect(out.report).toContain("pacer: stopped after 30 min without output or file changes");
  } finally { f.cleanup(); }
}, 40_000);
