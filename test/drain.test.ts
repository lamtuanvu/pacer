import { expect, setSystemTime, test } from "bun:test";
import { drainQueue } from "../src/tasks/drain";
import { pause } from "../src/core/pause";
import { runTask } from "../src/tasks/runner";
import { readTask, updateTask } from "../src/tasks/store";
import { queueTask, queueDeps } from "./queue-helpers";
import { pairStrategy } from "./fixtures/balance-pair";
import { validateStrategy } from "../src/config/strategy";
import { fakeCtx } from "./helpers";
import { policyGateFixture } from "./fixtures/policy-host";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeHooks } from "../src/classify/active";

function waiting(ctx: ReturnType<typeof fakeCtx>, goal: string, createdAt: number, executor: string | null = null) {
  const task = queueTask({...ctx, now: createdAt}, goal, executor);
  return updateTask(ctx, task.id, t => {t.queue = {reason: "no_slot", since: createdAt, position: 1};});
}
test("one free slot drains only the oldest task and reserves it across drains", async () => {
  const ctx = fakeCtx(), a = waiting(ctx, "a", ctx.now - 3), b = waiting(ctx, "b", ctx.now - 2), c = waiting(ctx, "c", ctx.now - 1);
  const spawned: string[] = [], spawn = (_: unknown, id: string) => {spawned.push(id); return process.pid;};
  const results = await Promise.all([drainQueue(ctx, spawn, queueDeps()), drainQueue(ctx, spawn, queueDeps())]);
  expect(results.flat()).toEqual([a.id]); expect(spawned).toEqual([a.id]);
  expect(readTask(ctx, a.id)?.queue).toBeUndefined();
  expect(readTask(ctx, b.id)?.queue).toBeDefined(); expect(readTask(ctx, c.id)?.queue).toBeDefined();
});
test("no policy plugins: slow status and classification do not stall the queued head",async()=>{
  const ctx=fakeCtx(),a=waiting(ctx,"first",ctx.now-2);
  let clock=0;
  const base=queueDeps();
  const deps={...base,now:()=>clock,computeStatus:async (...args:Parameters<typeof base.computeStatus>)=>{
    clock+=10_001;
    return base.computeStatus(...args);
  },hooks:{...activeHooks,taskKind:async()=>{clock+=10_001;return "feature" as const;},filterExecutors:async (_ctx:unknown,_task:unknown,candidates:string[])=>candidates}};
  expect(await drainQueue(ctx,()=>process.pid,deps)).toEqual([a.id]);
});
test("open drain finishes its first slow policy evaluation and leaves later work queued",async()=>{
  const f=policyGateFixture({verdict:"allow"});
  writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),JSON.stringify({...f.config,plugins:{...f.config.plugins,policy:{mode:"open"}}}));
  const a=waiting(f.ctx,"first",f.ctx.now-2),b=waiting(f.ctx,"second",f.ctx.now-1);
  const deps={...queueDeps(),now:()=>f.calls().length?10_001:0};
  expect(await drainQueue(f.ctx,()=>process.pid,deps)).toEqual([a.id]);
  expect(readTask(f.ctx,b.id)).toMatchObject({state:"queued"});
  expect(f.calls()).toHaveLength(1);
});
test("closed drain finishes its first slow policy evaluation and leaves later work queued",async()=>{
  const f=policyGateFixture({verdict:"allow"});
  const a=waiting(f.ctx,"first",f.ctx.now-2),b=waiting(f.ctx,"second",f.ctx.now-1);
  const deps={...queueDeps(),now:()=>f.calls().length?10_001:0};
  expect(await drainQueue(f.ctx,()=>process.pid,deps)).toEqual([a.id]);
  expect(readTask(f.ctx,b.id)).toMatchObject({state:"queued"});
  expect(f.calls()).toHaveLength(1);
});
test("pinned removed executor fails with a clear report; unpinned work is reranked", async () => {
  const ctx = fakeCtx(), pinned = waiting(ctx, "pinned", ctx.now - 2, "missing"), other = waiting(ctx, "other", ctx.now - 1);
  expect(await drainQueue(ctx, () => process.pid, queueDeps())).toEqual([other.id]);
  expect(readTask(ctx, pinned.id)?.result).toMatchObject({status: "failed", report: "missing was removed while the task waited"});
});
test("runner settlement drains without a daemon", async () => {
  const ctx = fakeCtx(), active = queueTask(ctx, "active"), queued = waiting(ctx, "waiting", ctx.now - 1), spawned: string[] = [];
  const deps = queueDeps(); deps.spawnRunner = (_, id) => {spawned.push(id); return process.pid;};
  await runTask(ctx, active.id, deps);
  expect(spawned).toEqual([queued.id]);
});
test("drain leaves work paused, then starts it after expiry", async () => {
  const ctx = fakeCtx(), task = waiting(ctx, "waiting", ctx.now), state = pause(ctx, {for: "1h"});
  expect(await drainQueue(ctx, () => process.pid, queueDeps())).toEqual([]);
  expect(await drainQueue({...ctx, now: state.until!}, () => process.pid, queueDeps())).toEqual([task.id]);
});
test("failed spawn restores the queue for a later drain", async () => {
  const ctx = fakeCtx(), task = waiting(ctx, "waiting", ctx.now);
  await expect(drainQueue(ctx, () => {throw Error("spawn failed");}, queueDeps())).rejects.toThrow("spawn failed");
  expect(readTask(ctx, task.id)).toMatchObject({state: "queued", queue: {reason: "no_slot"}});
  expect(await drainQueue(ctx, () => process.pid, queueDeps())).toEqual([task.id]);
});
test("a dispatched reservation can be claimed exactly once by its runner", async () => {
  const ctx = fakeCtx(), task = waiting(ctx, "waiting", ctx.now), deps = queueDeps();
  expect(await drainQueue(ctx, () => process.pid, deps)).toEqual([task.id]);
  let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(r => {release = r;}), started = new Promise<void>(r => {entered = r;});
  const attempt = deps.runAttempt!;
  deps.runAttempt = async (...args) => {calls++; entered(); await gate; return attempt(...args);};
  const first = runTask(ctx, task.id, deps); await started;
  expect((await runTask(ctx, task.id, deps)).state).toBe("running");
  expect(calls).toBe(1); release(); expect((await first).state).toBe("done");
});
test("a reservation is claimed even when the claim lands in the same clock tick as the drain", async () => {
  // With a frozen clock the runner's claim write changes nothing, so it keeps the task's revision.
  setSystemTime(new Date(Date.now()));
  try {
    const ctx = fakeCtx(), task = waiting(ctx, "waiting", ctx.now), deps = queueDeps();
    expect(await drainQueue(ctx, () => process.pid, deps)).toEqual([task.id]);
    expect((await runTask(ctx, task.id, deps)).state).toBe("done");
  } finally { setSystemTime(); }
}, 10_000);
test("an unpinned task drops its removed executor when draining", async () => {
  const ctx = fakeCtx(), task = waiting(ctx, "waiting", ctx.now);
  updateTask(ctx, task.id, t => {t.executor = "removed";});
  await drainQueue(ctx, () => process.pid, queueDeps());
  expect(readTask(ctx, task.id)).toMatchObject({state: "running", executor: "codex"});
});

test("balance on: four tasks through two equal executors drained in one pass land 2 and 2", async () => {
  const ctx = fakeCtx();
  const tasks = ["a", "b", "c", "d"].map((goal, i) => waiting(ctx, goal, ctx.now - 10 + i));
  const deps = queueDeps(pairStrategy("least-loaded"));
  expect(await drainQueue(ctx, (_, id) => process.pid, deps)).toEqual(tasks.map(t => t.id));
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    const executor = readTask(ctx, t.id)?.executor;
    if (executor) counts[executor] = (counts[executor] ?? 0) + 1;
  }
  expect(counts).toEqual({ codex: 2, "opencode#tse": 2 });
});

test("balance off: the pick stays the distilled permitted order even when a hook returns candidates in another order", async () => {
  // permitted is distilled in rank order; with balance off the first permitted executor runs
  // exactly as `permitted.find` did before load-aware balance existed, so a classifier hook that
  // suggests a different order cannot change the pick.
  const ctx = fakeCtx();
  const task = waiting(ctx, "waiting", ctx.now);
  const deps = {...queueDeps(pairStrategy("off")), hooks: {...activeHooks, filterExecutors: async (_ctx: unknown, _task: unknown, ranked: string[]) => [...ranked].reverse()}};
  expect(await drainQueue(ctx, () => process.pid, deps)).toEqual([task.id]);
  expect(readTask(ctx, task.id)).toMatchObject({state: "running", executor: "codex"});
});

test("balance on: survivors left by a mid-band exclusion sort by load within their band", async () => {
  // ranked is [codex, t1(NEAR_LIMIT), t2]: t1 splits the two ON_PACE executors into separate
  // bands. The route hook drops t1, and nothing may run on the loaded codex: balancing only the
  // permitted list must see codex and t2 as one band and start the idle t2, where reordering the
  // full rank list before filtering keeps the t1-shaped band gap and starts the loaded codex.
  const ctx = fakeCtx();
  const trioStrategy = (balance: "off" | "least-loaded") => validateStrategy({
    planner: "claude-code",
    accounts: {"claude-code": {kind: "claude"}, codex: {kind: "codex"}, t1: {kind: "endpoint", usage: "quota", quota_source: "arkcli"}, t2: {kind: "endpoint", usage: "quota", quota_source: "arkcli"}},
    runners: {codex: {max_tasks: 3}, "opencode#t1": {model: "go/t1", max_tasks: 3}, "opencode#t2": {model: "go/t2", max_tasks: 3}},
    pacing: {policy: "priority", order: ["codex", "opencode#t1", "opencode#t2"], balance},
    routing: [{default: ["codex", "opencode#t1", "opencode#t2"]}],
  }, "/x");
  const holding = queueTask(ctx, "holding", "codex");
  updateTask(ctx, holding.id, t => {t.state = "running"; t.executor = "codex";});
  const task = waiting(ctx, "waiting", ctx.now);
  const base = queueDeps(trioStrategy("least-loaded"));
  const deps = {...base,
    hooks: {...activeHooks, filterExecutors: async (_ctx: unknown, _task: unknown, ranked: string[]) => ranked.filter(id => id !== "opencode#t1")},
    computeStatus: async (...args: Parameters<typeof base.computeStatus>) => {
      const st = await base.computeStatus(...args);
      return {...st, providers: st.providers.map(p => p.id === "opencode#t1" ? {...p, verdict: "NEAR_LIMIT" as const} : p)};
    }};
  expect(await drainQueue(ctx, () => process.pid, deps)).toEqual([task.id]);
  expect(readTask(ctx, task.id)).toMatchObject({state: "running", executor: "opencode#t2"});
});

test("balance off: the same batch lands 3 and 1 on the first executor (fill-then-spill guard)", async () => {
  const ctx = fakeCtx();
  const tasks = ["a", "b", "c", "d"].map((goal, i) => waiting(ctx, goal, ctx.now - 10 + i));
  const deps = queueDeps(pairStrategy("off"));
  expect(await drainQueue(ctx, () => process.pid, deps)).toEqual(tasks.map(t => t.id));
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    const executor = readTask(ctx, t.id)?.executor;
    if (executor) counts[executor] = (counts[executor] ?? 0) + 1;
  }
  expect(counts).toEqual({ codex: 3, "opencode#tse": 1 });
});

test("balance on: the runner keeps the drain's reservation even when its own load count would favour another executor", async () => {
  // Unequal caps: tse carries 2 slots, codex 3. The drain reserves the queued task on tse
  // (codex 1/3 is ahead of the empty tse 0/2). Before the runner claims it, another attempt
  // lands on tse: at the runner's own admission (which excludes the task itself) tse counts
  // 1/2 against codex 1/3, so balancing would move the task to the emptier codex, but the
  // reservation is kept.
  const ctx = fakeCtx();
  const s = validateStrategy({
    planner: "claude-code",
    accounts: {"claude-code": {kind: "claude"}, codex: {kind: "codex"}, tse: {kind: "endpoint", usage: "quota", quota_source: "arkcli"}},
    runners: {codex: {max_tasks: 3}, "opencode#tse": {model: "go/t", max_tasks: 2}},
    pacing: {policy: "priority", order: ["codex", "opencode#tse"], balance: "least-loaded"},
    routing: [{default: ["codex", "opencode#tse"]}],
  }, "/x");
  const busy = queueTask(ctx, "busy");
  updateTask(ctx, busy.id, t => {t.state = "running"; t.executor = "codex";});
  const deps = queueDeps(s);
  const task = waiting(ctx, "waiting", ctx.now);
  expect(await drainQueue(ctx, () => process.pid, deps)).toEqual([task.id]);
  expect(readTask(ctx, task.id)).toMatchObject({state: "running", executor: "opencode#tse"});
  const loaded = queueTask(ctx, "load");
  updateTask(ctx, loaded.id, t => {t.state = "running"; t.executor = "opencode#tse";});
  const result = await runTask(ctx, task.id, deps);
  expect(result.attempts[0].executor).toBe("opencode#tse");
});

test("a lane waiting on its question with a live worker keeps its slot, so the queue does not drain into it", async () => {
  const ctx = fakeCtx(), lane = queueTask(ctx, "lane"), task = waiting(ctx, "waiting", ctx.now);
  updateTask(ctx, lane.id, t => {
    t.state = "needs_input"; t.executor = "codex"; t.question = {text: "which?", at: ctx.now}; delete t.queue;
    t.live = {backend: "orca", worker: "ctx_live", terminal: "term_live", executor: "codex", agent: "codex", since: ctx.now};
  });
  expect(await drainQueue(ctx, () => process.pid, queueDeps())).toEqual([]);
  updateTask(ctx, lane.id, t => { delete t.live; });
  expect(await drainQueue(ctx, () => process.pid, queueDeps())).toEqual([task.id]);
});
