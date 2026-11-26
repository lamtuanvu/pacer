// An orchestrator turn runs only on the run's planner (P3, API-5b): it waits for the planner
// and never falls back to an executor, which would hand that executor the run grant.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeProjectStrategy } from "../src/config/project-strategies";
import { resolveRepo } from "../src/core/repos";
import { validateStrategy, type Strategy } from "../src/config/strategy";
import { retry } from "../src/core/tasks";
import { dispatchDatabase } from "../src/dispatch/store";
import { blockExecutor, unblockExecutor } from "../src/executors/blocked";
import { sendMessage } from "../src/messaging/send";
import { drainQueue } from "../src/tasks/drain";
import { runTask, type RunnerDeps } from "../src/tasks/runner";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { getRun, insertRun } from "../src/workflow/store";
import { defaultPlannerPacing, orchestrateRuns } from "../src/workflow/orchestrator";
import { markExhausted } from "../src/usage/reactive";
import { TERMINAL_STATES } from "../src/tasks/types";
import { insertTurn } from "../src/workflow/wakeups";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import { queueDeps, queueStrategy, queueTask } from "./queue-helpers";

type Launch = { executor: string; role: string | undefined; grant: boolean };

function setup(o: { ctx?: ReturnType<typeof fakeCtx>; strategy?: Strategy; planner?: string; status?: Record<string, Record<string, unknown>> } = {}) {
  const ctx = o.ctx ?? fakeCtx(), s = o.strategy ?? queueStrategy(true), deps: RunnerDeps = queueDeps(s);
  const planner = o.planner ?? "claude-code";
  const status = o.status ?? {};
  const base = deps.computeStatus!, attempt = deps.runAttempt!;
  deps.computeStatus = async (...args) => {
    const st = await base(...args);
    st.providers = st.providers.map(p => ({ ...p, ...status[p.id] }));
    return st;
  };
  const launched: Launch[] = [];
  deps.runAttempt = async (c, cfg, ...rest) => {
    launched.push({ executor: cfg.id, role: c.env.PACER_ROLE, grant: !!c.env.PACER_RUN_GRANT });
    return attempt(c, cfg, ...rest);
  };
  const run = insertRun(ctx, { workflow: "t/orch", version: 1, repo: ctx.home, brief: "b", planner });
  const created = createTask(ctx, { brief: { goal: "decide", repo: ctx.home }, kind: "orchestrate", requestedExecutor: planner, timeoutS: 60, requestId: `orch:${run.id}` });
  insertTurn(ctx, { id: "turn_1", runId: run.id, planner, status: "running", taskId: created.id, startedAt: ctx.now, deadline: ctx.now + 1200 });
  const spawned: string[] = [];
  const spawn = (_: unknown, id: string) => { spawned.push(id); return process.pid; };
  return { ctx, deps, run, id: created.id, launched, spawned, spawn, status, s };
}

const occupy = (ctx: Ctx, executor: string) => {
  const busy = queueTask(ctx as ReturnType<typeof fakeCtx>, "busy");
  return updateTask(ctx, busy.id, t => { t.state = "running"; t.executor = executor; t.runnerPid = process.pid; }).id;
};
const oneSlotPlanner = () => validateStrategy({ planner: "claude-code", providers: { "claude-code": { max_tasks: 1 }, codex: {} }, pacing: { policy: "priority" } }, "test");
/** The runner delays the next try; the drain must wait that long and no longer. */
const due = (ctx: Ctx, id: string) => updateTask(ctx, id, t => { if (t.queue) delete t.queue.nextAt; });

test("a turn queued for a full planner is relaunched on the planner once the slot frees", async () => {
  const f = setup({ strategy: oneSlotPlanner() });
  const busy = occupy(f.ctx, "claude-code");
  const queued = await runTask(f.ctx, f.id, f.deps);
  expect(queued).toMatchObject({ state: "queued", queue: { reason: "no_slot" } });
  expect(await drainQueue(f.ctx, f.spawn, f.deps)).toEqual([]);
  updateTask(f.ctx, busy, t => { t.state = "done"; delete t.runnerPid; });
  expect(await drainQueue(f.ctx, f.spawn, f.deps)).toEqual([f.id]);
  expect(readTask(f.ctx, f.id)).toMatchObject({ state: "running", executor: "claude-code" });
  await runTask(f.ctx, f.id, f.deps);
  expect(f.launched).toEqual([{ executor: "claude-code", role: "orchestrator", grant: true }]);
});

for (const [name, unavailable] of [
  ["not installed", { installed: false }],
  ["signed out", { signedOutReason: "Sign in to Claude" }],
  ["unavailable", { unavailableReason: "CLI is missing" }],
] as const) test(`a ${name} planner keeps the turn queued and no executor receives it`, async () => {
  const f = setup({ status: { "claude-code": { ...unavailable } } });
  const result = await runTask(f.ctx, f.id, f.deps);
  expect(f.launched).toEqual([]);
  expect(result.state).toBe("queued");
  expect(result.queue?.reason).toBe("waiting_retry");
  expect(result.queue?.detail).toContain("claude-code");
  expect(result.queue?.detail).toContain("only on the run's planner");
  expect(result.executor).toBeUndefined();
  // The drain does not spawn a runner for an unavailable planner, and starts it once it is back.
  due(f.ctx, f.id);
  expect(await drainQueue(f.ctx, f.spawn, f.deps)).toEqual([]);
  expect(readTask(f.ctx, f.id)?.queue?.detail).toContain("only on the run's planner");
  delete f.status["claude-code"];
  expect(await drainQueue(f.ctx, f.spawn, f.deps)).toEqual([f.id]);
  expect(readTask(f.ctx, f.id)?.executor).toBe("claude-code");
});

test("a planner missing from the strategy keeps the turn queued instead of failing or falling back", async () => {
  const f = setup({ strategy: validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "test"), planner: "cursor" });
  const result = await runTask(f.ctx, f.id, f.deps);
  expect(result).toMatchObject({ state: "queued", queue: { reason: "waiting_retry" } });
  due(f.ctx, f.id);
  expect(await drainQueue(f.ctx, f.spawn, f.deps)).toEqual([]);
  expect(readTask(f.ctx, f.id)?.state).toBe("queued");
  expect(f.launched).toEqual([]);
});

test("a planner left out of every routing rule still takes its own turn", async () => {
  const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} }, routing: [{ default: ["codex"] }] }, "test");
  const f = setup({ strategy: s });
  await runTask(f.ctx, f.id, f.deps);
  expect(f.launched).toEqual([{ executor: "claude-code", role: "orchestrator", grant: true }]);
});

test("a blocked planner refuses the turn as a planner hold, never on an executor", async () => {
  const f = setup();
  blockExecutor(f.ctx, "claude-code");
  const result = await runTask(f.ctx, f.id, f.deps);
  expect(f.launched).toEqual([]);
  expect(result.result?.report).toContain('requested executor "claude-code" is unavailable (Blocked by you)');
  unblockExecutor(f.ctx, "claude-code");
});

test("a planner attempt that hits a limit does not move the turn to an executor", async () => {
  const f = setup(), attempt = f.deps.runAttempt!;
  f.deps.runAttempt = async (c, cfg, ...rest) => {
    const out = await attempt(c, cfg, ...rest);
    return { ...out, exec: { ...out.exec, code: 1 }, attempt: { ...out.attempt, exitCode: 1, limitHit: true } };
  };
  const result = await runTask(f.ctx, f.id, f.deps);
  expect(f.launched.map(l => l.executor)).toEqual(["claude-code"]);
  expect(result.state).toBe("limit");
});

test("a planner that stops being eligible just before launch keeps the turn queued", async () => {
  const f = setup(), base = f.deps.computeStatus!;
  let reads = 0;
  f.deps.computeStatus = async (...args) => {
    const st = await base(...args);
    if (++reads > 1) st.providers = st.providers.map(p => p.id === "claude-code" ? { ...p, installed: false } : p);
    return st;
  };
  const result = await runTask(f.ctx, f.id, f.deps);
  expect(f.launched).toEqual([]);
  expect(result).toMatchObject({ state: "queued", queue: { reason: "waiting_retry" } });
  expect(result.executor).toBeUndefined();
  expect(result.attempts).toEqual([]);
});

test("an executor written onto the turn is replaced by the run's planner", async () => {
  for (const path of ["runner", "drain"] as const) {
    const f = setup();
    updateTask(f.ctx, f.id, t => { t.requestedExecutor = "codex"; if (path === "drain") t.queue = { reason: "no_slot", since: f.ctx.now, position: 1 }; });
    if (path === "drain") expect(await drainQueue(f.ctx, f.spawn, f.deps)).toEqual([f.id]);
    await runTask(f.ctx, f.id, f.deps);
    expect(f.launched.map(l => l.executor)).toEqual(["claude-code"]);
    expect(readTask(f.ctx, f.id)?.requestedExecutor).toBe("claude-code");
  }
});

test("a resumed attempt on an executor gets no run grant", async () => {
  const f = setup();
  updateTask(f.ctx, f.id, t => {
    t.state = "running"; t.executor = "codex";
    t.run = { attempt: 1, executor: "codex", dir: f.ctx.home, startedAt: f.ctx.now, workdir: f.ctx.home } as NonNullable<typeof t.run>;
  });
  await runTask(f.ctx, f.id, f.deps);
  expect(readTask(f.ctx, f.id)?.attempts.map(a => a.executor)).toEqual(["codex"]);
  expect(dispatchDatabase(f.ctx).query("SELECT hash FROM work_grants WHERE kind = 'run'").all()).toEqual([]);
});

test("a run whose planner is another agent runs the turn there", async () => {
  const f = setup({ planner: "codex" });
  await runTask(f.ctx, f.id, f.deps);
  expect(f.launched).toEqual([{ executor: "codex", role: "orchestrator", grant: true }]);
});

const twoAccounts = {
  planner: { agent: "claude-code", account: "work" },
  accounts: { "claude-code": { kind: "claude" }, work: { kind: "claude", home: "/tmp/claude-work" }, codex: { kind: "codex" } },
  runners: { "claude-code": {}, "claude-code#work": {}, codex: {} },
};
const writeTwoAccounts = (ctx: Ctx) => {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify(twoAccounts));
};

for (const restriction of ["blocked", "limited"] as const) test(`planner pacing reads the planner account, not the default account (${restriction})`, () => {
  const ctx = fakeCtx();
  writeTwoAccounts(ctx);
  const restrict = (id: string) => restriction === "blocked" ? blockExecutor(ctx, id) : markExhausted(ctx, id, ctx.now + 600);
  restrict("claude-code");
  expect(defaultPlannerPacing(ctx, "claude-code")).toEqual({ eligible: true });
  restrict(restriction === "blocked" ? "claude-code#work" : "work");
  expect(defaultPlannerPacing(ctx, "claude-code")).toMatchObject({ eligible: false, hold: restriction === "blocked" ? "blocked" : "limit" });
});

test("a limited turn wakes at the planner account's reset, not the default account's", async () => {
  const f = setup();
  writeTwoAccounts(f.ctx);
  markExhausted(f.ctx, "claude-code", f.ctx.now + 100);
  markExhausted(f.ctx, "work", f.ctx.now + 5000);
  updateTask(f.ctx, f.id, t => { t.state = "limit"; });
  await orchestrateRuns(f.ctx, { spawn: () => 1 });
  expect(getRun(f.ctx, f.run.id)?.nextWakeAt).toBe(f.ctx.now + 5000);
});

for (const state of TERMINAL_STATES) test(`holding a turn for its planner never revives a ${state} task`, async () => {
  const f = setup(), base = f.deps.computeStatus!;
  let reads = 0;
  f.deps.computeStatus = async (...args) => {
    const st = await base(...args);
    if (++reads === 2) {
      updateTask(f.ctx, f.id, t => { t.state = state; });
      st.providers = st.providers.map(p => p.id === "claude-code" ? { ...p, installed: false } : p);
    }
    return st;
  };
  const result = await runTask(f.ctx, f.id, f.deps);
  expect(result.state).toBe(state);
  expect(result.queue).toBeUndefined();
  expect(f.launched).toEqual([]);
});

test("the configured planner account takes the turn when the agent has several accounts", async () => {
  const s = validateStrategy(twoAccounts, "test");
  const f = setup({ strategy: s });
  const deps = f.deps, base = deps.computeStatus!;
  deps.computeStatus = async (...args) => {
    const st = await base(...args);
    st.providers = Object.keys(s.runners).map(id => ({ ...st.providers[0]!, id, installed: true, verdict: "ON_PACE" as const, windows: [], binding: null, stale: false, usage: "quota" as const }));
    return st;
  };
  await runTask(f.ctx, f.id, deps);
  expect(f.launched.map(l => l.executor)).toEqual(["claude-code#work"]);
});

test("a project allowlist still refuses the turn and never hands it to a listed executor", async () => {
  const f = setup({ ctx: fakeCtx({ home: gitRepo(), run: realRun }) });
  const repo = await resolveRepo(f.ctx, f.ctx.home);
  mkdirSync(f.ctx.pacerHome, { recursive: true });
  await writeProjectStrategy(f.ctx, repo.key, ["codex#codex@local"], 0);
  updateTask(f.ctx, f.id, t => { t.repo = repo; t.requestedExecutor = "codex"; t.queue = { reason: "no_slot", since: f.ctx.now, position: 1 }; });
  expect(await drainQueue(f.ctx, f.spawn, f.deps)).toEqual([]);
  expect(readTask(f.ctx, f.id)?.result?.report).toContain("claude-code is forbidden by project policy");
  expect(f.launched).toEqual([]);
});

test("task.retry refuses an orchestrator turn", async () => {
  const f = setup();
  updateTask(f.ctx, f.id, t => { t.state = "failed"; });
  for (const executor of ["codex", undefined]) {
    await expect(retry(f.ctx, f.id, { executor })).rejects.toMatchObject({ code: "not_allowed" });
  }
  expect(readTask(f.ctx, f.id)?.retriedBy).toBeUndefined();
});

test("a message turn on an orchestrator task never replays on an executor", async () => {
  const f = setup({ strategy: validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} }, routing: [{ default: ["codex"] }] }, "test") });
  updateTask(f.ctx, f.id, t => {
    t.state = "done";
    t.result = { status: "done", executor: "codex", model: null, files: "", report: "", backend: "direct" };
  });
  await sendMessage({ ...f.ctx, env: { ...f.ctx.env, CLAUDECODE: "1" } }, { to: `task:${f.id}`, body: "continue", requestId: "orch-msg" }, { spawnRunner: () => process.pid });
  const task = readTask(f.ctx, f.id)!;
  expect(task.pendingTurn?.executor ?? "claude-code").toBe("claude-code");
  expect(task.requestedExecutor).toBe("claude-code");
});
