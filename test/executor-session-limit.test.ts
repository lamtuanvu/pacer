import { expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../src/core/errors";
import { retryLoopOutcome, sessionLimitOutcome, stopAtSessionLimit } from "../src/plugins/executor-production";
import { startRunMonitor } from "../src/plugins/executor-run-monitor";
import { readRun, startRun, stopRun } from "../src/supervisor/run";
import { Recording } from "../src/session/recording";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { RunRef } from "../src/tasks/types";
import { fakeCtx, tmpDir } from "./helpers";

const LIMIT = "Cursor Agent\n  Error: Weekly usage limit reached. It resets in 5 days.\n  rateLimitReason: prepaid_balance_exhausted\n";
const lease = new CoreError("plugin_timeout", "observation lease expired");

/** A live owned interactive Cursor run whose screen has been quiet for a minute. */
async function ownedRun(screen: string, o: {executor?: string; controller?: boolean} = {}) {
  const ctx = fakeCtx(), dir = tmpDir();
  // The run prints its own screen: the wrapper truncates stdout when it starts, so a screen
  // written from outside can be wiped after the fact.
  const started = startRun({dir, argv: ["sh", "-c", 'printf "%s" "$SCREEN"; exec sleep 30'], cwd: dir, env: {PATH: process.env.PATH, SCREEN: screen}});
  if ("error" in started) throw new Error(started.error);
  const printed = () => existsSync(join(dir, "stdout")) && readFileSync(join(dir, "stdout"), "utf8").includes(screen.trim());
  for (const end = Date.now() + 5000; !printed(); await Bun.sleep(10)) {
    if (Date.now() > end) throw new Error("the run never printed its screen");
  }
  writeFileSync(join(dir, "interactive.json"), "{}");
  if (o.controller) writeFileSync(join(dir, "session.state"), JSON.stringify({controller: "terminal"}));
  const quiet = Date.now() / 1000 - 60;
  utimesSync(join(dir, "stdout"), quiet, quiet);
  const task = createTask(ctx, {brief: {goal: "limit", repo: dir}, kind: null, requestedExecutor: null, timeoutS: 600});
  const run: RunRef = {dir, attempt: 1, executor: o.executor ?? "cursor", startedAt: quiet - 60, mode: "current", workdir: dir, logFile: join(dir, "log"), session: "interactive"};
  updateTask(ctx, task.id, t => { t.state = "running"; t.run = run; t.executorProvider = "pacer-exec-direct"; });
  return {ctx, id: task.id, run, expected: {attempt: 1, dir, executor: run.executor}};
}

test("a lease renewal stops a quiet session that shows the provider's limit error", async () => {
  const {ctx, id, run, expected} = await ownedRun(LIMIT);
  await stopAtSessionLimit(ctx, id, lease, expected);
  expect(readRun(run.dir).exit).not.toBeNull();
}, 15_000);

test("other errors, other agents, plain screens and a person driving never stop the session", async () => {
  for (const [screen, error, o] of [
    [LIMIT, new CoreError("conflict", "x"), {}],
    [LIMIT, lease, {executor: "codex"}],
    ["Implemented rate limit handling; usage limit reached errors now return 429\n", lease, {}],
    [LIMIT, lease, {controller: true}],
  ] as const) {
    const {ctx, id, run, expected} = await ownedRun(screen, o);
    try {
      await stopAtSessionLimit(ctx, id, error, expected);
      expect(readRun(run.dir).alive).toBe(true);
    } finally { await stopRun(run.dir, {graceMs: 500}); }
  }
}, 30_000);

test("an ended session with the limit on screen is a limit outcome unless it reported a result", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "interactive.json"), "{}");
  writeFileSync(join(dir, "stdout"), LIMIT);
  const out = {exec: {code: 143, timedOut: false}, report: "Interactive session exited without an explicit completion report"};
  expect(sessionLimitOutcome("cursor", dir, out)).toBe(true);
  expect(out.report).toContain("Usage limit reached:\nError: Weekly usage limit reached");
  expect(sessionLimitOutcome("cursor", dir, {exec: {code: 0, timedOut: false}, report: ""})).toBe(false);
  writeFileSync(join(dir, "report.json"), JSON.stringify({status: "failed", summary: "Tests failed", source: "agent", at: Date.now() / 1000}));
  expect(sessionLimitOutcome("cursor", dir, {exec: {code: 1, timedOut: false}, report: ""})).toBe(false);
});

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name));
const RATE_LIMIT = "opencode-retry-ratelimit.ansi", HTTP_524 = "opencode-retry-524.ansi";
const exited = (code = 143) => ({exec: {code, stdout: "", stderr: "", timedOut: false}, report: "Interactive session exited without an explicit completion report",
  attempt: {limitHit: false, exitCode: code} as {limitHit: boolean; exitCode: number; brokenReason?: string}});

/** A live owned interactive OpenCode run whose PTY recording plays a retry banner fixture; still printing (not quiet). */
async function opencodeRun(name: string, o: {run?: Partial<RunRef>; controller?: boolean; status?: () => string; argv?: string[]} = {}) {
  const ctx = fakeCtx(o.status ? {run: async () => ({code: 0, stdout: o.status!(), stderr: ""})} : {}), dir = tmpDir();
  const started = startRun({dir, argv: o.argv ?? ["sh", "-c", "exec sleep 30"], cwd: dir, env: {PATH: process.env.PATH}});
  if ("error" in started) throw new Error(started.error);
  for (const end = Date.now() + 5000; !readRun(dir).alive; await Bun.sleep(10)) if (Date.now() > end) throw new Error("the run never started");
  writeFileSync(join(dir, "interactive.json"), "{}");
  if (o.controller) writeFileSync(join(dir, "session.state"), JSON.stringify({controller: "terminal"}));
  const recording = new Recording(dir);
  await recording.output(fixture(name));
  const task = createTask(ctx, {brief: {goal: "retry", repo: dir}, kind: null, requestedExecutor: null, timeoutS: 7200});
  const run: RunRef = {dir, attempt: 1, executor: "opencode#tse", startedAt: Date.now() / 1000 - 60, mode: "current", workdir: dir, logFile: join(dir, "log"), session: "interactive", ...o.run};
  updateTask(ctx, task.id, t => { t.state = "running"; t.run = run; t.executorProvider = "pacer-exec-direct"; t.startIntent = {attempt: 1, providerId: "pacer-exec-direct", dir}; });
  const close = async () => { await recording.close(); await stopRun(dir, {graceMs: 500}); };
  return {ctx, id: task.id, run, dir, recording, close, expected: {attempt: 1, dir, executor: run.executor}};
}
/** The run monitor the plugin path runs while its executor.run call is pending, until the run exits or `ms` passes. */
async function monitored(r: {ctx: ReturnType<typeof fakeCtx>; id: string; dir: string}, ms = 5000): Promise<void> {
  const monitor = startRunMonitor(r.ctx, r.id, r.dir, {pollMs: 50});
  try { for (const end = Date.now() + ms; readRun(r.dir).exit === null && Date.now() < end;) await Bun.sleep(20); }
  finally { await monitor.stop(); }
}
const openWindow = (since: number) => ({run: {retryBanner: {since: Date.now() / 1000 - since, reason: "Provider request failed with HTTP 524"}}});

test("the run monitor stops an animating OpenCode rate-limit banner and the outcome is a limit", async () => {
  const r = await opencodeRun(RATE_LIMIT);
  try {
    await monitored(r);
    expect(readRun(r.dir).exit).not.toBeNull();
    // The verdict is on the task record, so an outcome read after a service restart still sees it.
    const out = exited();
    expect(retryLoopOutcome(r.ctx, r.id, r.run.executor, r.dir, out)).toBe(true);
    expect(out.attempt.limitHit).toBe(true);
    expect(out.attempt.brokenReason).toBeUndefined();
    expect(out.report).toContain("\n\nUsage limit reached:\nRate limit exceeded");
  } finally { await r.close(); }
}, 15_000);

test("the run monitor stops a transient banner after the window and the outcome is broken with the provider reason", async () => {
  const r = await opencodeRun(HTTP_524, openWindow(10 * 60 + 1));
  try {
    await monitored(r);
    expect(readRun(r.dir).exit).not.toBeNull();
    const out = exited();
    expect(retryLoopOutcome(r.ctx, r.id, r.run.executor, r.dir, out)).toBe(true);
    expect(out.attempt.limitHit).toBe(false);
    expect(out.attempt.brokenReason).toBe("provider retrying: Provider request failed with HTTP 524");
    expect(out.report).toMatch(/pacer: opencode#tse kept retrying a provider error for 10 min: .*HTTP 524/);
    expect(out.exec.stderr).toMatch(/pacer: opencode#tse kept retrying a provider error for 10 min: .*HTTP 524/);
  } finally { await r.close(); }
}, 15_000);

test("a transient banner inside the window is left running", async () => {
  for (const o of [{}, openWindow(9 * 60)]) {
    const r = await opencodeRun(HTTP_524, o);
    try {
      const before = Date.now() / 1000;
      await monitored(r, 500);
      expect(readRun(r.dir).alive).toBe(true);
      const banner = readTask(r.ctx, r.id)!.run!.retryBanner!;
      expect(banner.reason).toContain("HTTP 524");
      expect(banner.ended).toBeUndefined();
      if ("run" in o) expect(banner.since).toBeLessThan(before - 8 * 60);
      expect(retryLoopOutcome(r.ctx, r.id, r.run.executor, r.dir, exited())).toBe(false);
    } finally { await r.close(); }
  }
}, 15_000);

test("a lease renewal leaves the retry banner to the run monitor", async () => {
  for (const [name, o] of [[RATE_LIMIT, {}], [HTTP_524, openWindow(3600)]] as const) {
    const r = await opencodeRun(name, o);
    try {
      await stopAtSessionLimit(r.ctx, r.id, lease, r.expected);
      expect(readRun(r.dir).alive).toBe(true);
      expect(readTask(r.ctx, r.id)!.run!.retryBanner?.ended).toBeUndefined();
    } finally { await r.close(); }
  }
}, 30_000);

test("a conversation lane is never stopped for a banner", async () => {
  for (const name of [RATE_LIMIT, HTTP_524]) {
    const r = await opencodeRun(name, {run: {interactionMode: "conversation", retryBanner: {since: Date.now() / 1000 - 3600, reason: "HTTP 524"}}});
    try {
      await monitored(r, 500);
      expect(readRun(r.dir).alive).toBe(true);
    } finally { await r.close(); }
  }
}, 30_000);

test("a human driving the session is never stopped", async () => {
  for (const name of [RATE_LIMIT, HTTP_524]) {
    const r = await opencodeRun(name, {controller: true, run: {retryBanner: {since: Date.now() / 1000 - 3600, reason: "HTTP 524"}}});
    try {
      await monitored(r, 500);
      expect(readRun(r.dir).alive).toBe(true);
    } finally { await r.close(); }
  }
}, 30_000);

test("an agent that exits 0 on the monitor's stop still ends as its banner verdict", async () => {
  for (const [name, o] of [[RATE_LIMIT, {}], [HTTP_524, openWindow(10 * 60 + 1)]] as const) {
    const r = await opencodeRun(name, {...o, argv: ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 0.1; done"]});
    try {
      await monitored(r);
      // The wrapper records its own 143 for a stop; the agent's 0 is what a reported outcome code can carry.
      expect(readRun(r.dir).exit).not.toBeNull();
      const out = exited(0);
      expect(retryLoopOutcome(r.ctx, r.id, r.run.executor, r.dir, out)).toBe(true);
      expect(out.exec.code).toBe(1);
      expect(out.attempt.exitCode).toBe(1);
      if (name === RATE_LIMIT) expect(out.attempt.limitHit).toBe(true);
      else expect(out.attempt.brokenReason).toStartWith("provider retrying: ");
    } finally { await r.close(); }
  }
}, 30_000);

test("an explicit completion report outranks a recorded banner verdict", async () => {
  const r = await opencodeRun(RATE_LIMIT);
  try {
    await monitored(r);
    for (const status of ["done", "failed"]) {
      writeFileSync(join(r.dir, "report.json"), JSON.stringify({status, summary: "Finished", source: "agent", at: Date.now() / 1000}));
      const out = exited(status === "done" ? 0 : 1);
      expect(retryLoopOutcome(r.ctx, r.id, r.run.executor, r.dir, out)).toBe(false);
      expect(out.attempt.limitHit).toBe(false);
    }
  } finally { await r.close(); }
}, 15_000);
