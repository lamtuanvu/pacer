import { expect, test } from "bun:test";
import { drainQueue } from "../src/tasks/drain";
import { pause } from "../src/core/pause";
import { runTask } from "../src/tasks/runner";
import { readTask, updateTask } from "../src/tasks/store";
import { queueTask, queueDeps } from "./queue-helpers";
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
test("an unpinned task drops its removed executor when draining", async () => {
  const ctx = fakeCtx(), task = waiting(ctx, "waiting", ctx.now);
  updateTask(ctx, task.id, t => {t.executor = "removed";});
  await drainQueue(ctx, () => process.pid, queueDeps());
  expect(readTask(ctx, task.id)).toMatchObject({state: "running", executor: "codex"});
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
