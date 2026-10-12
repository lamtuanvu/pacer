import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import type { ProviderStatus } from "../src/engine/rank";
import type { Status } from "../src/engine/status";
import type { AttemptOutcome } from "../src/exec/direct";
import { type RunnerDeps, runTask } from "../src/tasks/runner";
import { taskStop } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { readMarks } from "../src/usage/reactive";
import { fakeCtx } from "./helpers";

const strategy = validateStrategy({
  planner: "claude-code",
  providers: { "claude-code": {}, codex: {}, cursor: {}, agy: {} },
  pacing: { policy: "priority" },
}, "/x");

function status(overrides: Record<string, Partial<ProviderStatus>> = {}): Status {
  const providers = Object.keys(strategy.providers).map((id) => ({
    id, usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false, ...overrides[id],
  })) as ProviderStatus[];
  return { generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, calendarPace: true, providers, executors: { ranked: [], excluded: [] } };
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

test("first executor in priority order succeeds: done with verification", async () => {
  const ctx = fakeCtx();
  const t = newTask(ctx, { acceptance: "bun test" });
  const d = deps({ codex: outcomeFor("codex", 0) });
  const r = await runTask(ctx, t.id, d);
  expect(d.calls).toEqual(["codex"]);
  expect(r.state).toBe("done");
  expect(r.result).toMatchObject({ status: "done", executor: "codex", files: "a.ts | 2 +-", report: "codex report", backend: "direct" });
  expect(r.result?.acceptance?.passed).toBe(true);
  expect(r.attempts.length).toBe(1);
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

test("non-limit failure stops without fallback; failing acceptance is partial", async () => {
  const ctx = fakeCtx();
  const failed = await runTask(ctx, newTask(ctx).id, deps({ codex: outcomeFor("codex", 2) }));
  expect(failed.result).toMatchObject({ status: "failed", executor: "codex" });
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
  const exhausted = deps({}, status({ codex: { verdict: "EXHAUSTED" } }));
  const r2 = await runTask(ctx, newTask(ctx, { requestedExecutor: "codex" }).id, exhausted);
  expect(exhausted.calls).toEqual([]);
  expect(r2.result).toMatchObject({ status: "limit", executor: null });
  expect(r2.result?.report).toContain('requested executor "codex" is unavailable (exhausted)');
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
  expect(r.result).toMatchObject({ status: "stopped", report: "codex report" });
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
  expect(r.result).toMatchObject({ status: "stopped", report: "codex report", files: "a.ts", acceptance: { passed: true } });
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
    expect((await runTask(ctx,newTask(ctx).id,d)).state).toBe("failed");
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
 await Bun.sleep(10);
 const second=await runTask(ctx,b.id,d);
 expect(second.state).toBe("failed");expect(second.result?.report).toContain("already active");expect(d.calls).toEqual(["codex"]);
 const forced=newTask(ctx);updateTask(ctx,forced.id,t=>{t.force=true;});
 const third=runTask(ctx,forced.id,d);await Bun.sleep(10);release();await Promise.all([first,third]);
 expect(d.calls).toEqual(["codex","codex"]);
});
