import { eligibility, exhaustedEligibility } from "./fixtures/eligibility";
import { diff } from "../src/core/tasks";
import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import type { ProviderStatus } from "../src/engine/rank";
import type { Status } from "../src/engine/status";
import { chmodSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runAttempt } from "../src/exec/direct";
import type { AttemptOutcome } from "../src/exec/direct";
import { type RunnerDeps, runTask } from "../src/tasks/runner";
import { taskStop } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { readAuthFailures } from "../src/usage/auth";
import { readMarks } from "../src/usage/reactive";
import { fakeCtx } from "./install-plugin-fixtures";
import { gitRepo, realRun, tmpDir } from "./helpers";
import { installPlanner } from "../src/install";
import { PACER } from "./install-helpers";

const strategy = validateStrategy({
  planner: "claude-code",
  providers: { "claude-code": {}, codex: {}, cursor: {}, agy: {} },
  pacing: { policy: "priority" },
}, "/x");

function status(overrides: Record<string, Partial<ProviderStatus>> = {}): Status {
  const providers = Object.keys(strategy.providers).map((id) => ({
    id, eligibility: overrides[id]?.verdict === "EXHAUSTED" ? exhaustedEligibility() : eligibility(), usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false, ...overrides[id],
  })) as ProviderStatus[];
  return { generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, paused: null, modeHold: null, calendarPace: true, providers, executors: { ranked: [], excluded: [] } };
}

function outcomeFor(executor: string, code: number, limitHit = false, report = `${executor} report`): AttemptOutcome {
  return {
    exec: { code, stdout: report, stderr: "", timedOut: false },
    report,
    attempt: { executor, model: null, startedAt: 1, endedAt: 2, exitCode: code, timedOut: false, limitHit, log: `/l/${executor}.log` },
  };
}

function deps(plan: Record<string, AttemptOutcome>, st: Status = status(), accepted = true): RunnerDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    loadStrategy: () => strategy,
    computeStatus: async () => st,
    runAttempt: async (_ctx, cfg) => { calls.push(cfg.id); return plan[cfg.id]; },
    verifyRepo: async (_repo, acceptance) => ({ files: "a.ts | 2 +-", ...(acceptance ? { acceptance: { cmd: acceptance, passed: accepted, tail: "t" } } : {}) }),
  };
}

const newTask = (ctx: ReturnType<typeof fakeCtx>, extra: { requestedExecutor?: string | null; acceptance?: string } = {}) =>
  createTask(ctx, { brief: { goal: "g", repo: "/r", acceptance: extra.acceptance }, kind: null, requestedExecutor: extra.requestedExecutor ?? null, timeoutS: 60 });

test("brief.pipefail reaches verifyRepo's pipefail argument", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: "/r", acceptance: "true", pipefail: true }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const calls: unknown[][] = [];
  const d = deps({ codex: outcomeFor("codex", 0) });
  d.verifyRepo = async (...args) => { calls.push(args); return { files: "", acceptance: { cmd: "true", passed: true, tail: "" } }; };
  await runTask(ctx, task.id, d);
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toBe("true");
  expect(calls[0][4]).toBe(true);
});

// A conversation now takes the same path as a delegated task once it settles: a real diff, an
// optional acceptance check, and needs_input/review/retry eligibility (interactive lanes design,
// decision 4), instead of a bare done/failed verdict with no verification.
test("conversation exit now runs delegated acceptance and becomes eligible for review", async () => {
  const ctx = fakeCtx(), task = newTask(ctx, {acceptance: "echo ok"});
  updateTask(ctx, task.id, t => {t.interactionMode = "conversation";});
  const d = deps({codex: outcomeFor("codex", 0)});
  const result = await runTask(ctx, task.id, d);
  expect(result.state).toBe("done");
  expect(result.conversation).toMatchObject({activity: "ended", endReason: "agent_exit"});
  expect(result.result?.acceptance).toMatchObject({cmd: "echo ok", passed: true});
  expect(result.review).toBeUndefined();
  expect(result.reviewRequest).toBeUndefined();
});

// A conversation's requested executor is tried first, same as a delegated task's requestedExecutor,
// but on a limit it now falls back to the next ranked candidate instead of being stuck exclusively
// on the one requested (decision 4: selected or rejected by the same decision engine as any task).
test("conversation limit falls back to the next ranked executor, preferring the requested one first", async () => {
  const ctx = fakeCtx(), task = newTask(ctx, {requestedExecutor: "codex"});
  updateTask(ctx, task.id, t => {t.interactionMode = "conversation";});
  const d = deps({codex: outcomeFor("codex", 1, true), cursor: outcomeFor("cursor", 0)});
  const result = await runTask(ctx, task.id, d);
  expect(d.calls).toEqual(["codex", "cursor"]);
  expect(result.state).toBe("done");
  expect(result.result?.executor).toBe("cursor");
});

test("conversation integration failure includes the repair hint in its task report", async () => {
  const ctx = fakeCtx({env: {PACER_BIN: PACER[0]}});
  await installPlanner({ctx, pacerArgv: PACER}, "claude-code");
  const path = join(ctx.home, ".claude", "settings.json");
  const settings = JSON.parse(await Bun.file(path).text());
  settings.hooks.SessionStart[0].hooks[0].timeout = 99;
  writeFileSync(path, JSON.stringify(settings));
  const task = newTask(ctx, {requestedExecutor: "claude-code"});
  updateTask(ctx, task.id, t => {t.interactionMode = "conversation";});

  const result = await runTask(ctx, task.id, deps({"claude-code": outcomeFor("claude-code", 0)}));
  expect(result.state).toBe("failed");
  expect(result.result?.report).toContain("Preserve your customizations");
  expect(result.result?.report).toContain("pacer install claude-code");
});

test("conversation ranking still honors pacing.policy priority ordering (EXPIRING promoted ahead of AHEAD)", async () => {
  const ctx = fakeCtx(), task = newTask(ctx);
  updateTask(ctx, task.id, t => {t.interactionMode = "conversation";});
  // codex is AHEAD (demoted last by the priority policy) and would run first under a naive static
  // order; cursor is EXPIRING (promoted first). A conversation with no requested executor and no
  // project selection must still pick by this ordering, not by configured/static provider order.
  const d = deps({cursor: outcomeFor("cursor", 0)}, status({codex: {verdict: "AHEAD"}, cursor: {verdict: "EXPIRING"}}));
  const result = await runTask(ctx, task.id, d);
  expect(d.calls).toEqual(["cursor"]);
  expect(result.state).toBe("done");
  expect(result.result?.executor).toBe("cursor");
});

test("conversation waits for its unavailable executor instead of switching accounts", async () => {
  const ctx = fakeCtx(), task = newTask(ctx, {requestedExecutor: "codex"});
  updateTask(ctx, task.id, t => {t.interactionMode = "conversation";});
  const d = deps({cursor: outcomeFor("cursor", 0)}, status({codex: {verdict: "EXHAUSTED"}}));
  const result = await runTask(ctx, task.id, d);
  expect(d.calls).toEqual([]);
  expect(result.state).toBe("queued");
  expect(result.requestedExecutor).toBe("codex");
  expect(result.queue?.detail).toContain("exhausted");
});

test("first executor in priority order succeeds: done with verification", async () => {
  const ctx = fakeCtx();
  const t = newTask(ctx, { acceptance: "bun test" });
  const d = deps({ codex: outcomeFor("codex", 0) });
  const r = await runTask(ctx, t.id, d);
  expect(d.calls).toEqual(["codex"]);
  expect(r.state).toBe("done");
  expect(r.result).toMatchObject({ status: "done", executor: "codex", files: "a.ts | 2 +-", report: expect.stringContaining("codex report"), backend: "direct" });
  expect(r.result?.acceptance?.passed).toBe(true);
  expect(r.attempts.length).toBe(1);
});

test("task completion refreshes readable account usage after a turn", async () => {
  for (const [executor, expected] of [["codex", ["codex"]], ["cursor", []]] as const) {
    const ctx = fakeCtx();
    const t = newTask(ctx, {requestedExecutor: executor});
    const d = deps({[executor]: outcomeFor(executor, 0)});
    const opts: unknown[] = [];
    d.computeStatus = async (_ctx, _strategy, options) => { opts.push(options); return status(); };
    await runTask(ctx, t.id, d);
    expect(opts.at(-1)).toMatchObject({refreshAccounts: expected});
  }
});

test("limit falls back and marks exhausted", async () => {
  const ctx = fakeCtx({ now: 1000 });
  const t = newTask(ctx);
  const d = deps({ codex: outcomeFor("codex", 1, true), cursor: outcomeFor("cursor", 0) });
  const r = await runTask(ctx, t.id, d);
  expect(d.calls).toEqual(["codex", "cursor"]);
  expect(r.result).toMatchObject({ status: "done", executor: "cursor" });
  expect(r.attempts.map((a) => a.executor)).toEqual(["codex", "cursor"]);
  expect(readMarks(ctx).codex).toBeGreaterThan(Date.now() / 1000);
});

test("non-limit failure with changes needs review without fallback; failing acceptance is partial", async () => {
  const ctx = fakeCtx();
  const failed = await runTask(ctx, newTask(ctx).id, deps({ codex: outcomeFor("codex", 2) }));
  expect(failed.result).toMatchObject({ status: "partial", executor: "codex" });
  const partial = await runTask(ctx, newTask(ctx, { acceptance: "x" }).id, deps({ codex: outcomeFor("codex", 0) }, status(), false));
  expect(partial.result?.status).toBe("partial");
});

test("every executor hitting a limit ends in limit after at most 3 attempts", async () => {
  const ctx = fakeCtx();
  const d = deps({ codex: outcomeFor("codex", 1, true), cursor: outcomeFor("cursor", 1, true), agy: outcomeFor("agy", 1, true) });
  const r = await runTask(ctx, newTask(ctx).id, d);
  expect(d.calls).toEqual(["codex", "cursor", "agy"]);
  expect(r.result?.status).toBe("limit");
  expect(r.result?.report).toContain("every executor tried hit a limit");
});

test("requested executor is used alone; unavailable requested executor explains why", async () => {
  const ctx = fakeCtx();
  const d = deps({ agy: outcomeFor("agy", 0) });
  const r = await runTask(ctx, newTask(ctx, { requestedExecutor: "agy" }).id, d);
  expect(d.calls).toEqual(["agy"]);
  expect(r.result?.executor).toBe("agy");
  const exhausted = deps({ cursor: outcomeFor("cursor", 0) }, status({ codex: { verdict: "EXHAUSTED" } }));
  const r2 = await runTask(ctx, newTask(ctx, { requestedExecutor: "codex" }).id, exhausted);
  expect(exhausted.calls).toEqual([]);
  expect(r2.state).toBe("failed");
  expect(r2.result?.report).toContain('requested executor "codex" is unavailable (Budget exhausted; paid execution is not allowed)');

});

test("no executor available at all reports the exclusions; the planner is never used", async () => {
  const ctx = fakeCtx();
  const none = status({ codex: { verdict: "EXHAUSTED" }, cursor: { installed: false }, agy: { verdict: "EXHAUSTED" } });
  const d = deps({}, none);
  const r = await runTask(ctx, newTask(ctx).id, d);
  expect(d.calls).toEqual([]);
  expect(r.result?.report).toContain("no executor available");
  expect(r.result?.report).toContain("cursor: not installed");
  expect(readTask(ctx, r.id)?.state).toBe("limit");
});

test("a throwing dependency finishes the task as failed with the error", async () => {
  const ctx = fakeCtx();
  const t = newTask(ctx);
  const d = deps({});
  d.computeStatus = async () => { throw new Error("boom"); };
  const r = await runTask(ctx, t.id, d);
  expect(r.state).toBe("failed");
  expect(r.result?.report).toContain("pacer runner error: boom");
  expect(readTask(ctx, t.id)).toMatchObject({ state: "failed", result: { report: expect.stringContaining("pacer runner error: boom") } });
});

test("a throwing runAttempt records the executor", async () => {
  const ctx = fakeCtx();
  const t = newTask(ctx);
  const d = deps({});
  d.runAttempt = async () => { throw new Error("spawn exploded"); };
  const r = await runTask(ctx, t.id, d);
  expect(r.result).toMatchObject({ status: "failed", executor: "codex" });
  expect(r.result?.report).toContain("spawn exploded");
});


test("a task stopped before the runner starts never runs an executor", async () => {
  const ctx = fakeCtx();
  const t = newTask(ctx);
  taskStop(ctx, t.id);
  const d = deps({ codex: outcomeFor("codex", 0) });
  const r = await runTask(ctx, t.id, d);
  expect(r.state).toBe("stopped");
  expect(r.result).toMatchObject({ status: "stopped", report: "stopped before an executor ran" });
  expect(d.calls).toEqual([]);
  expect(r.attempts).toEqual([]);
});

test("a stop while budgets are awaiting prevents the executor from running", async () => {
  const ctx = fakeCtx();
  const t = newTask(ctx);
  const d = deps({ codex: outcomeFor("codex", 0) });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  d.computeStatus = async () => { await gate; return status(); };
  const running = runTask(ctx, t.id, d);
  taskStop(ctx, t.id);
  resume();
  const r = await running;
  expect(r.state).toBe("stopped");
  expect(r.result?.report).toBe("stopped before an executor ran");
  expect(d.calls).toEqual([]);
  expect(r.attempts).toEqual([]);
});

test("a successful attempt cannot undo a stop recorded during execution", async () => {
  const ctx = fakeCtx();
  const t = newTask(ctx);
  const d = deps({});
  d.runAttempt = async () => { taskStop(ctx, t.id); return outcomeFor("codex", 0); };
  const r = await runTask(ctx, t.id, d);
  expect(r.state).toBe("stopped");
  expect(r.result).toMatchObject({ status: "stopped", report: expect.stringContaining("codex report") });
  expect(r.attempts[0].exitCode).toBe(0);
});

test("a stop during verification preserves the report and verification", async () => {
  const ctx = fakeCtx();
  const t = newTask(ctx, { acceptance: "true" });
  const d = deps({ codex: outcomeFor("codex", 0) });
  d.verifyRepo = async () => {
    taskStop(ctx, t.id);
    return { files: "a.ts", acceptance: { cmd: "true", passed: true, tail: "ok" } };
  };
  const r = await runTask(ctx, t.id, d);
  expect(r.state).toBe("stopped");
  expect(r.result).toMatchObject({ status: "stopped", report: expect.stringContaining("codex report"), files: "a.ts", acceptance: { passed: true } });
});

test("a dependency error cannot undo a recorded stop", async () => {
  const ctx = fakeCtx();
  const t = newTask(ctx);
  const d = deps({});
  d.computeStatus = async () => { taskStop(ctx, t.id); throw new Error("stopped budgets"); };
  const r = await runTask(ctx, t.id, d);
  expect(r.state).toBe("stopped");
  expect(r.result).toMatchObject({ status: "stopped", report: "pacer runner error: stopped budgets" });
});


test("a stop before onSpawn immediately signals the new executor's process group", async () => {
  const ctx = fakeCtx();
  const t = newTask(ctx);
  const d = deps({});
  const signals: Array<[number, NodeJS.Signals | number | undefined]> = [];
  const kill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (signal !== 0) signals.push([pid, signal]);
    return true;
  }) as typeof process.kill;
  d.runAttempt = async (_ctx, _cfg, _task, onSpawn) => {
    taskStop(ctx, t.id);
    onSpawn?.(123_456);
    return outcomeFor("codex", 0);
  };
  try {
    const r = await runTask(ctx, t.id, d);
    expect(signals).toEqual([[-123_456, "SIGTERM"]]);
    expect(r.state).toBe("stopped");
    expect(r.childPid).toBeUndefined();
  } finally { process.kill = kill; }
});

test("a terminal task never restarts an executor", async () => {
  const ctx = fakeCtx();
  const t = newTask(ctx);
  updateTask(ctx, t.id, (x) => { x.state = "done"; });
  const d = deps({ codex: outcomeFor("codex", 0) });
  const r = await runTask(ctx, t.id, d);
  expect(r.state).toBe("stopped");
  expect(r.result?.report).toBe("stopped before an executor ran");
  expect(d.calls).toEqual([]);
});

const launchFailure = (executor: string, stderr: string, code = 2) => {
  const out = outcomeFor(executor, code);
  out.exec.stderr = stderr;
  return out;
};
test("startup usage error falls back and persists broken executor", async () => {
  const ctx = fakeCtx();
  const d = deps({ codex: launchFailure("codex", "error: unexpected argument '--sandbox' found"), cursor: outcomeFor("cursor", 0) });
  ctx.run = async () => ({code:0, stdout:"", stderr:""});
  const r = await runTask(ctx, newTask(ctx).id, d);
  expect(d.calls).toEqual(["codex", "cursor"]);
  expect(r.state).toBe("done");
  expect(r.attempts[0].brokenReason).toContain("unexpected argument");
  const marks = await Bun.file(`${ctx.pacerHome}/broken.json`).json();
  expect(marks.codex.until).toBeGreaterThan(Date.now()/1000 + 1700);
  const next = await runTask(ctx, newTask(ctx).id, d);
  expect(next.result?.executor).toBe("cursor");
});
for (const [name, out] of [
  ["agy prompt pairing", launchFailure("codex", 'Error: -p took "--sandbox" as its prompt')],
  ["missing command", launchFailure("codex", "ENOENT",127)],
  ["permission denied", launchFailure("codex", "permission denied",126)],
] as const) test(`${name} is a broken startup`, async () => {
  const ctx=fakeCtx({run:async()=>({code:0,stdout:"",stderr:""})});
  const d=deps({codex:out,cursor:outcomeFor("cursor",0)});
  expect((await runTask(ctx,newTask(ctx).id,d)).state).toBe("done");
  expect(d.calls).toEqual(["codex","cursor"]);
});
test("usage-like failure after work or after ten seconds is not retried", async () => {
  for (const changed of [true,false]) {
    let n=0;
    const ctx=fakeCtx({run:async()=>({code:0,stdout:changed&&n++>2?"changed":"",stderr:""})});
    const out=launchFailure("codex","error: unknown option --bad");
    if(!changed) out.attempt.endedAt=12;
    const d=deps({codex:out});
    expect((await runTask(ctx,newTask(ctx).id,d)).state).toBe("partial");
    expect(d.calls).toEqual(["codex"]);
  }
});
test("current executor and backend are persisted before execution", async()=>{
  const ctx=fakeCtx(), t=newTask(ctx), d=deps({});
  d.runAttempt=async()=>{
    expect(readTask(ctx,t.id)).toMatchObject({executor:"codex",backend:"direct",attemptStartedAt:expect.any(Number)});
    return outcomeFor("codex",0);
  };
  expect((await runTask(ctx,t.id,d)).state).toBe("done");
});
test("successful retry dismisses its failed ancestors only after done", async()=>{
  const ctx=fakeCtx(), original=newTask(ctx);
  updateTask(ctx,original.id,t=>{t.state="failed";});
  const retry=newTask(ctx);updateTask(ctx,retry.id,t=>{t.retryOf=original.id;});
  const d=deps({codex:outcomeFor("codex",0)});
  expect(readTask(ctx,original.id)?.dismissed).toBeUndefined();
  await runTask(ctx,retry.id,d);
  expect(readTask(ctx,original.id)?.dismissed).toBe(true);
});

test("concurrent identical briefs launch only one executor unless forced",async()=>{
 const ctx=fakeCtx();const a=newTask(ctx),b=newTask(ctx),d=deps({});
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 d.runAttempt=async()=>{d.calls.push("codex");await gate;return outcomeFor("codex",0);};
 const first=runTask(ctx,a.id,d);
 for(let i=0;i<400&&!d.calls.length;i++)await Bun.sleep(5);
 const second=await runTask(ctx,b.id,d);
 expect(second.state).toBe("failed");expect(second.result?.report).toContain("already active");expect(d.calls).toEqual(["codex"]);
 const forced=newTask(ctx);updateTask(ctx,forced.id,t=>{t.force=true;});
 const third=runTask(ctx,forced.id,d);await Bun.sleep(10);release();await Promise.all([first,third]);
 expect(d.calls).toEqual(["codex","codex"]);
});

 test("previously broken agy does not replace codex limit outcome",async()=>{
 const {markBroken}=await import("../src/exec/broken");const ctx=fakeCtx();markBroken({...ctx,now:Date.now()/1000},"agy","bad agy launch");
 const d=deps({codex:outcomeFor("codex",1,true)},status({cursor:{installed:false}}));
 const r=await runTask(ctx,newTask(ctx).id,d);
 expect(r.state).toBe("limit");expect(r.result?.executor).toBe("codex");expect(r.result?.report).toContain("codex");expect(r.result?.brokenExecutor).toBeUndefined();
 });
 test("a broken attempt followed by a limit retains the last real outcome",async()=>{
 const ctx=fakeCtx({run:async()=>({code:0,stdout:"",stderr:""})});const d=deps({codex:launchFailure("codex","unknown option --bad"),cursor:outcomeFor("cursor",1,true)},status({agy:{installed:false}}));
 const r=await runTask(ctx,newTask(ctx).id,d);expect(r.state).toBe("limit");expect(r.result?.executor).toBe("cursor");expect(r.result?.brokenExecutor).toBeUndefined();
 });
 for(const stderr of ['Error: -p took "--sandbox" as its prompt','ENOENT','ConnectionRefused: Unable to connect to LM Studio','error: unexpected argument --bad found','Usage: cursor-agent [options]']) test(`non-git launch errors fall back: ${stderr}`,async()=>{
 const ctx=fakeCtx({run:async()=>({code:128,stdout:"",stderr:"not a git repository"})});const d=deps({codex:launchFailure("codex",stderr),cursor:outcomeFor("cursor",0)});
 const r=await runTask(ctx,newTask(ctx).id,d);expect(r.state).toBe("done");expect(r.attempts[0].brokenReason).toBeTruthy();expect(d.calls).toEqual(["codex","cursor"]);
 });

 test("requested broken executor falls back even when another broken mark was inserted first",async()=>{
 const {markBroken}=await import("../src/exec/broken");const ctx=fakeCtx();const at={...ctx,now:Date.now()/1000};
 markBroken(at,"agy","agy usage error");markBroken(at,"codex","codex usage error");
 const d=deps({cursor:outcomeFor("cursor",0)});
 const r=await runTask(ctx,newTask(ctx,{requestedExecutor:"codex"}).id,d);
 expect(d.calls).toEqual(["cursor"]);expect(r.state).toBe("done");expect(r.result?.report).toContain("codex usage error");
 });
 test("later limit report is retained when an earlier executor was broken",async()=>{
 const ctx=fakeCtx({run:async()=>({code:0,stdout:"",stderr:""})});
 const d=deps({codex:launchFailure("codex","unknown option --bad"),cursor:outcomeFor("cursor",1,true,"ActionRequiredError: You've hit your usage limit")},status({agy:{installed:false}}));
 const r=await runTask(ctx,newTask(ctx).id,d);expect(r.result?.report).toContain("ActionRequiredError");
 });

for (const unavailable of ["blocked", "broken", "not in the routing list"] as const) test(`requested executor falls back when ${unavailable}`, async () => {
  const ctx = fakeCtx();
  const requestedExecutor = unavailable === "not in the routing list" ? "missing" : "cursor";
  const d = deps({ codex: outcomeFor("codex", 0) }, status({ cursor: unavailable === "blocked" ? { blockedReason: "manual" } : { brokenReason: "bad CLI" } }));
  const r = await runTask(ctx, newTask(ctx, { requestedExecutor }).id, d);
  if (unavailable === "blocked") {
    expect(d.calls).toEqual([]);
    expect(r.state).toBe("failed");
    expect(r.result?.report).toContain("Blocked by you");
    return;
  }
  expect(d.calls).toEqual(["codex"]);
  expect(r.state).toBe("done");
  expect(r.result?.report).toContain(`requested ${requestedExecutor} unavailable (`);
  expect(r.result?.report).toContain("; ran on codex");
});

test("requested executor limit falls back without trying it twice", async () => {
  const ctx = fakeCtx();
  const d = deps({ cursor: outcomeFor("cursor", 1, true), codex: outcomeFor("codex", 0) });
  const r = await runTask(ctx, newTask(ctx, { requestedExecutor: "cursor" }).id, d);
  expect(d.calls).toEqual(["cursor", "codex"]);
  expect(r.state).toBe("done");
  expect(r.result?.report).toContain("requested cursor unavailable (limit); ran on codex");
  expect(r.executorFallback).toEqual({ requested: "cursor", reason: "limit", executor: "codex" });
});

test("an unavailable requested executor is recorded as a fallback in task data, JSON and CLI output", async () => {
  const ctx = fakeCtx();
  const d = deps({ codex: outcomeFor("codex", 0) }, status({ cursor: { signedOutReason: "signed out — run cursor-agent login" } }));
  const r = await runTask(ctx, newTask(ctx, { requestedExecutor: "cursor" }).id, d);
  expect(d.calls).toEqual(["codex"]);
  expect(r.executorFallback).toEqual({ requested: "cursor", reason: "signed out — run cursor-agent login", executor: "codex" });
  const { summarizeTask } = await import("../src/tasks/api");
  expect(summarizeTask(r)).toMatchObject({ requested_executor: "cursor", executor_fallback: { requested: "cursor", reason: "signed out — run cursor-agent login", executor: "codex" } });
  const { main } = await import("../src/cli");
  const shown = await main(["tasks", r.id], ctx);
  expect(shown.out).toContain("requested cursor, ran on codex: signed out — run cursor-agent login");
  const listed = await main(["tasks"], ctx);
  expect(listed.out.split("\n").find(line => line.startsWith(r.id))).toContain("requested cursor");
  // A requested executor that ran has no fallback.
  const direct = await runTask(ctx, newTask(ctx, { requestedExecutor: "codex" }).id, deps({ codex: outcomeFor("codex", 0) }));
  expect(direct.executorFallback).toBeUndefined();
});

for (const files of ["", "(no changes)", "(not a git repository)"]) test(`nonzero exit without work stays failed: ${files}`, async () => {
  const ctx = fakeCtx(), d = deps({ codex: outcomeFor("codex", 1) });
  d.verifyRepo = async () => ({ files });
  expect((await runTask(ctx, newTask(ctx).id, d)).state).toBe("failed");
});

for (const code of [137, 139]) test(`crash exit ${code} with changes stays failed`, async () => {
  const ctx = fakeCtx(), d = deps({ codex: outcomeFor("codex", code) });
  expect((await runTask(ctx, newTask(ctx).id, d)).state).toBe("failed");
});

test("timed out executor with changes stays failed", async () => {
 const ctx=fakeCtx(), out=outcomeFor("codex",1);
 out.exec.timedOut=true;out.attempt.timedOut=true;
 const d=deps({codex:out});
 expect((await runTask(ctx,newTask(ctx).id,d)).state).toBe("failed");
});

 test("a CLI startup error in an isolated worktree still marks the executor broken", async () => {
  const bin = tmpDir(); writeFileSync(join(bin, "cursor-agent"), "#!/bin/sh\necho 'error: unknown option --force' >&2\nexit 2\n"); chmodSync(join(bin, "cursor-agent"), 0o755);
  const ctx = fakeCtx({ run: realRun, env: { PATH: `${bin}:${process.env.PATH}` } }), repo = gitRepo();
  writeFileSync(join(repo, "planner-wip.txt"), "planner changes stay in the original repo");
  const t = createTask(ctx, { brief: { goal: "g", repo, worktreeBase: "head" }, kind: null, requestedExecutor: "cursor", timeoutS: 30 });
  const done = await runTask(ctx, t.id, { ...deps({}), runAttempt: (c, cfg, task, spawned) => runAttempt(c, {...cfg, session: "headless"}, task, spawned), computeStatus: async () => status({ codex: { installed: false }, agy: { installed: false } }) });
  expect(done.attempts[0].brokenReason).toContain("unknown option");
 });
test('limit marks the account and carries the reset reported by a named runner',async()=>{
 const ctx=fakeCtx(),s=validateStrategy({accounts:{plan:{kind:'claude'},team:{kind:'codex',home:'~/.codex-team'}},planner:'claude-code',routing:[{default:['codex#team']}]},'test');
 const st={...status(),providers:[{id:'codex#team',usage:'quota',windows:[],binding:null,verdict:'ON_PACE',installed:true,stale:false}]} as Status;
 const report="You've hit your weekly limit · resets Oct 18 at 1pm (Asia/Saigon)";
 await runTask(ctx,newTask(ctx).id,{...deps({}),loadStrategy:()=>s,computeStatus:async()=>st,runAttempt:async()=>outcomeFor('codex#team',1,true,report)});
 const until=readMarks(ctx).team;
 expect(until).toBeGreaterThan(Date.now()/1000);
 const reset=new Date(until*1000);expect(reset.getUTCMonth()).toBe(9);expect(reset.getUTCDate()).toBe(18);expect(reset.getUTCHours()).toBe(6);
 expect(readMarks(ctx)['codex#team']).toBeUndefined();
});

test("attempt authentication failures in output or logs mark the bound account", async () => {
  for (const source of ["output", "log"] as const) {
    const ctx = fakeCtx();
    const s = validateStrategy({accounts: {plan: {kind: "claude"}, team: {kind: "codex", home: "~/.codex-team"}}, planner: "claude-code", routing: [{default: ["codex#team"]}]}, "test");
    const st = {...status(), providers: [{id: "codex#team", usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false}]} as Status;
    const outcome = outcomeFor("codex#team", 1, false, source === "output" ? "401 Unauthorized" : "login failed");
    outcome.attempt.log = join(ctx.home, "attempt.log");
    writeFileSync(outcome.attempt.log, source === "log" ? "Please log in" : "");
    await runTask(ctx, newTask(ctx, {requestedExecutor: "codex#team"}).id, {...deps({"codex#team": outcome}, st), loadStrategy: () => s});
    expect(readAuthFailures(ctx)).toEqual({team: outcome.attempt.endedAt});
  }
});

test("a successful attempt whose work mentions auth errors does not sign the account out", async () => {
  const ctx = fakeCtx();
  const s = validateStrategy({accounts: {plan: {kind: "claude"}, team: {kind: "codex", home: "~/.codex-team"}}, planner: "claude-code", routing: [{default: ["codex#team"]}]}, "test");
  const st = {...status(), providers: [{id: "codex#team", usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false}]} as Status;
  const outcome = outcomeFor("codex#team", 0, false, "Added a test for 401 Unauthorized responses; authentication failed path covered");
  outcome.attempt.log = join(ctx.home, "attempt.log");
  writeFileSync(outcome.attempt.log, "expect(res.status).toBe(401) // 401 Unauthorized");
  await runTask(ctx, newTask(ctx, {requestedExecutor: "codex#team"}).id, {...deps({"codex#team": outcome}, st), loadStrategy: () => s});
  expect(readAuthFailures(ctx)).toEqual({});
});

test("attempt completion saves review changes before its checkout is removed", async () => {
  const repo = gitRepo(), ctx = fakeCtx({ run: realRun });
  const task = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: "codex", timeoutS: 60 });
  const d = deps({ codex: outcomeFor("codex", 0) });
  d.runAttempt = async () => {
    writeFileSync(join(repo, "change.txt"), "saved by runner\n");
    expect(Bun.spawnSync(["git", "-C", repo, "add", "."]).exitCode).toBe(0);
    return outcomeFor("codex", 0);
  };
  expect((await runTask(ctx, task.id, d)).state).toBe("done");
  rmSync(repo, { recursive: true });
  const saved = await diff(ctx, task.id);
  expect(saved.patch).toContain("+saved by runner");
  expect(saved.files).toContainEqual({ path: "change.txt", status: "added", added: 1, removed: 0, binary: false });
});

test("connected integration conflict blocks the selected backend before executor spawn", async () => {
  const { installPlanner } = await import("../src/install");
  const ctx = fakeCtx({ env: { PACER_BIN: "/opt/pacer/bin/pacer" } });
  await installPlanner({ ctx, pacerArgv: ["/opt/pacer/bin/pacer"] }, "codex");
  writeFileSync(join(ctx.home, ".codex/skills/pacer/SKILL.md"), "user customization");
  const task = newTask(ctx, { requestedExecutor: "codex" }), d = deps({ codex: outcomeFor("codex", 0) });
  const result = await runTask(ctx, task.id, d);
  expect(d.calls).toEqual([]);
  expect(result.state).toBe("failed");
  expect(result.result?.report).toContain("pacer install codex");
});

test("connected integration is refreshed before a conversation reaches its backend", async () => {
  const { installPlanner } = await import("../src/install");
  const { readFileSync } = await import("node:fs");
  const ctx = fakeCtx({ env: { PACER_BIN: "/opt/pacer/bin/pacer" } });
  await installPlanner({ ctx, pacerArgv: ["/opt/pacer/bin/pacer"] }, "codex");
  const path = join(ctx.home, ".codex/skills/pacer/SKILL.md"); rmSync(path);
  const task = newTask(ctx, { requestedExecutor: "codex" }); updateTask(ctx, task.id, t => { t.interactionMode = "conversation"; });
  const d = deps({ codex: outcomeFor("codex", 0) });
  d.runAttempt = async () => {
    expect(readFileSync(path, "utf8")).toContain("PACER_ROLE=executor");
    return outcomeFor("codex", 0);
  };
  expect((await runTask(ctx, task.id, d)).state).toBe("done");
});

test("a session.create chat stays on the direct backend; only an interactive lane may run on Orca", async () => {
  const { needsDirectBackend } = await import("../src/tasks/runner");
  const base = { interactionMode: "conversation" } as import("../src/tasks/types").TaskRecord;
  expect(needsDirectBackend(base, false)).toBe(true);
  expect(needsDirectBackend({ ...base, interactive: true }, false)).toBe(false);
  expect(needsDirectBackend({ ...base, interactive: true }, true)).toBe(true);
  expect(needsDirectBackend({} as import("../src/tasks/types").TaskRecord, false)).toBe(false);
});
