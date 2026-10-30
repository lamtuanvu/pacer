import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { execProcess } from "../src/exec/process";
import { DelegateError, delegate, selfCommand, superviseTask, taskStatus, taskStop, taskWait, validateInput } from "../src/tasks/api";
import { runTask } from "../src/tasks/runner";
import { listTasks, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "/x");

test("validation collects every problem", () => {
  const p = validateInput(s, { brief: { goal: " ", repo: "relative/path" }, kind: "dance", executor: "gemini", timeoutMin: 999 });
  expect(p).toEqual([
    "goal is required",
    "repo must be an absolute path",
    'unknown kind "dance" (allowed: boilerplate, tests, docs, rename, migration, feature, debug, refactor, performance, unfamiliar-code, research)',
    'unknown executor "gemini" (configured: claude-code, codex)',
    "timeout_min must be between 1 and 240",
  ]);
  expect(validateInput(s, { brief: { goal: "g", repo: "/definitely/not/here" } })).toEqual(["repo does not exist: /definitely/not/here"]);
  expect(validateInput(s, { brief: { goal: "g", repo: tmpDir() }, executor: "claude-code" })).toEqual(['"claude-code" is the planner; pick an executor']);
});

test("delegate creates a queued task and starts the runner; bad input creates nothing", async () => {
  const ctx = fakeCtx();
  const spawned: string[] = [];
  const t = (await delegate(ctx, { brief: { goal: "Fix", repo: tmpDir() }, kind: "debug", timeoutMin: 5 }, (_c, id) => { spawned.push(id); return 1; }, s));
  expect(t).toMatchObject({ state: "queued", kind: "debug", requestedExecutor: null, timeoutS: 300 });
  expect(spawned).toEqual([t.id]);
  await expect(delegate(ctx, { brief: { goal: "", repo: "x" } }, () => 1, s)).rejects.toThrow(DelegateError);
  expect(listTasks(ctx).length).toBe(1);
});

test("selfCommand re-runs the script under bun, or the compiled binary alone", () => {
  expect(selfCommand(["/bun", "/repo/src/cli.ts", "status"], "/bun")).toEqual(["/bun", "/repo/src/cli.ts"]);
  expect(selfCommand(["/usr/local/bin/pacer", "status"], "/usr/local/bin/pacer")).toEqual(["/usr/local/bin/pacer"]);
});

test("taskWait returns at a terminal state or at the timeout", async () => {
  const ctx = fakeCtx();
  const t = (await delegate(ctx, { brief: { goal: "g", repo: tmpDir() } }, () => 1, s));
  const early = await taskWait(ctx, t.id, 0.2, 50);
  expect(early?.state).toBe("queued");
  updateTask(ctx, t.id, (x) => { x.state = "done"; });
  expect((await taskWait(ctx, t.id, 5, 50))?.state).toBe("done");
  expect(await taskWait(ctx, "t-20261011-140500-abcd", 1, 50)).toBeNull();
});

test("dead runner is detected", async () => {
  const ctx = fakeCtx();
  const t = (await delegate(ctx, { brief: { goal: "g", repo: tmpDir() } }, () => 1, s));
  updateTask(ctx, t.id, (x) => { x.state = "running"; x.runnerPid = 999_999; x.attemptStartedAt = ctx.now; });
  const r = await superviseTask(ctx, t.id);
  expect(r?.state).toBe("failed");
  expect(r?.result?.report).toBe("the pacer runner exited unexpectedly");
});

test("a finished task is not overwritten by dead-runner detection", async () => {
  const ctx = fakeCtx();
  const t = (await delegate(ctx, { brief: { goal: "g", repo: tmpDir() } }, () => 1, s));
  const result = { status: "done" as const, executor: "codex", model: "m", files: "a.ts", report: "finished", backend: "direct" as const };
  updateTask(ctx, t.id, (x) => { x.state = "running"; x.runnerPid = 999_999; x.attemptStartedAt = ctx.now; });
  const kill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    updateTask(ctx, t.id, (x) => { x.state = "done"; x.result = result; });
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  }) as typeof process.kill;
  let r;
  try { r = await superviseTask(ctx, t.id); } finally { process.kill = kill; }
  expect(r?.state).toBe("done");
  expect(r?.result).toEqual(result);
});

test("stop does not overwrite a finished task", async () => {
  const ctx = fakeCtx();
  const t = (await delegate(ctx, { brief: { goal: "g", repo: tmpDir() } }, () => 1, s));
  const result = { status: "done" as const, executor: "codex", model: "m", files: "a.ts", report: "finished", backend: "direct" as const };
  updateTask(ctx, t.id, (x) => { x.state = "running"; x.runnerPid = 999_999; x.attemptStartedAt = ctx.now; });
  const kill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    updateTask(ctx, t.id, (x) => { x.state = "done"; x.result = result; });
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  }) as typeof process.kill;
  let r;
  try { r = taskStop(ctx, t.id); } finally { process.kill = kill; }
  expect(r?.state).toBe("done");
  expect(r?.result).toEqual(result);
});

test("stop kills the running executor and the task ends stopped", async () => {
  const ctx = fakeCtx({ env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const t = (await delegate(ctx, { brief: { goal: "g", repo: tmpDir() } }, () => 1, s));
  const running = runTask(ctx, t.id, {
    loadStrategy: () => s,
    computeStatus: async () => ({ generatedAt: 0, strategy: "d", planner: "claude-code", mode: "normal", disabled: false, paused: null, modeHold: null, calendarPace: true, executors: { ranked: [], excluded: [] },
      providers: [{ id: "codex", usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false }] }),
    runAttempt: async (_c, cfg, task, onSpawn) => {
      const exec = await execProcess({ argv: ["sleep", "30"], cwd: task.brief.repo, env: ctx.env, timeoutMs: 20_000, onSpawn });
      return { exec, report: "killed", attempt: { executor: cfg.id, model: null, startedAt: 0, endedAt: 0, exitCode: exec.code, timedOut: false, limitHit: false, log: "" } };
    },
    verifyRepo: async () => ({ files: "" }),
  });
  for (let i = 0; i < 100 && !readTask(ctx, t.id)?.childPid; i++) await Bun.sleep(20);
  expect(readTask(ctx, t.id)?.childPid).toBeGreaterThan(0);
  taskStop(ctx, t.id);
  const r = await running;
  expect(r.state).toBe("stopped");
  expect(r.result?.status).toBe("stopped");
});

test("stopping a queued task with no live runner finalizes it; terminal tasks are unchanged", async () => {
  const ctx = fakeCtx();
  const t = (await delegate(ctx, { brief: { goal: "g", repo: tmpDir() } }, () => 1, s));
  const r = taskStop(ctx, t.id);
  expect(r?.state).toBe("stopped");
  expect(r?.result?.report).toBe("stopped before an executor ran");
  expect(taskStop(ctx, t.id)?.state).toBe("stopped");
  expect(taskStop(ctx, "t-20261011-140500-abcd")).toBeNull();
});


test("a queued task without a runner fails after ten minutes but fresh tasks stay queued", async () => {
  const ctx = fakeCtx();
  const t = (await delegate(ctx, { brief: { goal: "g", repo: tmpDir() } }, () => undefined, s));
  expect(taskStatus(ctx, t.id)?.state).toBe("queued");
  expect(taskStatus({ ...ctx, now: ctx.now + 600 }, t.id)?.state).toBe("queued");
  const old = await superviseTask({ ...ctx, now: ctx.now + 601 }, t.id);
  expect(old?.state).toBe("failed");
  expect(old?.result).toMatchObject({ status: "failed", report: "the pacer runner never started" });
});

test("queued-runner expiry does not overwrite a terminal task or a recorded runner", async () => {
  const ctx = fakeCtx();
  const t = (await delegate(ctx, { brief: { goal: "g", repo: tmpDir() } }, () => undefined, s));
  updateTask(ctx, t.id, (x) => { x.runnerPid = process.pid; });
  expect(taskStatus({ ...ctx, now: ctx.now + 61 }, t.id)?.state).toBe("queued");
  taskStop(ctx, t.id);
  expect(taskStatus({ ...ctx, now: ctx.now + 61 }, t.id)?.state).toBe("stopped");
});

test("stop kills the executor's grandchild too", async () => {
  const ctx = fakeCtx({ env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const repo = tmpDir();
  const pidFile = join(repo, "gc.pid");
  const t = (await delegate(ctx, { brief: { goal: "g", repo } }, () => undefined, s));
  const running = runTask(ctx, t.id, {
    loadStrategy: () => s,
    computeStatus: async () => ({ generatedAt: 0, strategy: "d", planner: "claude-code", mode: "normal", disabled: false, paused: null, modeHold: null, calendarPace: true, executors: { ranked: [], excluded: [] },
      providers: [{ id: "codex", usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false }] }),
    runAttempt: async (_c, cfg, task, onSpawn) => {
      const exec = await execProcess({ argv: ["sh", "-c", `sleep 30 & echo $! > '${pidFile}'; wait`], cwd: task.brief.repo, env: ctx.env, timeoutMs: 1000, onSpawn });
      return { exec, report: "killed", attempt: { executor: cfg.id, model: null, startedAt: 0, endedAt: 0, exitCode: exec.code, timedOut: exec.timedOut, limitHit: false, log: "" } };
    },
    verifyRepo: async () => ({ files: "" }),
  });
  let pid = 0;
  try {
    for (let i = 0; i < 100 && (!readTask(ctx, t.id)?.childPid || !existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()); i++) await Bun.sleep(5);
    expect(readTask(ctx, t.id)?.childPid).toBeGreaterThan(0);
    pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    taskStop(ctx, t.id);
    const r = await running;
    await Bun.sleep(300);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(r.state).toBe("stopped");
    expect(r.result?.status).toBe("stopped");
    expect(r.attempts[0].timedOut).toBe(false);
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await running;
  }
});

test("legacy running records with attempts reconcile a dead runner immediately",async()=>{
 const ctx=fakeCtx();const t=(await delegate(ctx,{brief:{goal:"g",repo:tmpDir()}},()=>undefined,s));
 updateTask(ctx,t.id,x=>{x.state="running";x.attempts=[{executor:"codex",model:null,startedAt:1,endedAt:2,exitCode:1,timedOut:false,limitHit:true,log:""}];});
 expect((await superviseTask(ctx,t.id))?.state).toBe("failed");
});
 test("legacy running records without attempts expire after ten minutes",async()=>{
 const ctx=fakeCtx();const t=(await delegate(ctx,{brief:{goal:"g",repo:tmpDir()}},()=>undefined,s));
 updateTask(ctx,t.id,x=>{x.state="running";});
 expect(taskStatus(ctx,t.id)?.state).toBe("running");
 expect((await superviseTask({...ctx,now:ctx.now+601},t.id))?.state).toBe("failed");
});
