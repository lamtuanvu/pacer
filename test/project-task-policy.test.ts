import { expect, test } from "bun:test";
import { writeProjectStrategy } from "../src/config/project-strategies";
import { projectReferences } from "../src/engine/project-routing";
import { repoFor, resolveRepo } from "../src/core/repos";
import { defaultHooks } from "../src/classify/hooks";
import { delegate } from "../src/tasks/api";
import { runTask } from "../src/tasks/runner";
import { drainQueue } from "../src/tasks/drain";
import { listTasksWhere, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";
import { queueDeps, queueStrategy, queueTask } from "./queue-helpers";

async function setup(ids = ["cursor"]) {
  const ctx = fakeCtx(), s = queueStrategy(true), repo = await resolveRepo(ctx, ctx.home);
  await writeProjectStrategy(ctx, repo.key, projectReferences(s, ids), 0);
  return { ctx, s, repo, deps: { ...queueDeps(s), hooks: defaultHooks } };
}
test("forbidden explicit delegation including force fails before creation or spawn", async () => {
  const { ctx, s, repo } = await setup(); let spawned = 0;
  for (const force of [false, true]) expect(() => delegate(ctx, { brief: { goal: "work", repo: ctx.home }, repoRef: repo, executor: "codex", force }, () => { spawned++; return 1; }, s)).toThrow("project policy");
  expect(spawned).toBe(0); expect(listTasksWhere(ctx, {})).toHaveLength(0);
});
test("legacy tasks resolve policy and hooks cannot widen or reorder its list", async () => {
  const { ctx, deps } = await setup(["cursor", "codex"]), task = queueTask(ctx);
  deps.hooks = { ...defaultHooks, filterExecutors: async () => ["codex", "claude-code", "cursor"] };
  const result = await runTask(ctx, task.id, deps);
  expect(result.attempts.map(a => a.executor)).toEqual(["cursor"]);
  expect(result.repo?.key).toBe(repoFor(ctx, ctx.home).key);
  expect(result.attempts[0].routing?.policy).toMatchObject({ source: "project", rev: 1 });
});
test("policy edits during status calculation rerank before reservation", async () => {
  const { ctx, s, repo, deps } = await setup(["codex"]), task = queueTask(ctx);
  const status = deps.computeStatus; let changed = false;
  deps.computeStatus = async (...args) => {
    if (!changed) { changed = true; await writeProjectStrategy(ctx, repo.key, projectReferences(s, ["cursor"]), 1); }
    return status(...args);
  };
  const result = await runTask(ctx, task.id, deps);
  expect(result.attempts.map(a => a.executor)).toEqual(["cursor"]);
  expect(result.attempts[0].routing?.policy?.rev).toBe(2);
});
test("queued forbidden explicit selection settles without spawning", async () => {
  const { ctx, deps } = await setup(), task = queueTask(ctx, "work", "codex");
  updateTask(ctx, task.id, t => { t.queue = { reason: "paused", since: ctx.now, position: 1 }; });
  let spawned = 0;
  expect(await drainQueue(ctx, () => { spawned++; return 1; }, deps)).toEqual([]);
  expect(spawned).toBe(0);
  expect(listTasksWhere(ctx, {})[0].result?.report).toContain("project policy");
});
test("policy changes during an attempt apply to its fresh fallback", async () => {
  const { ctx, s, repo, deps } = await setup(["codex", "cursor"]), task = queueTask(ctx);
  const run = deps.runAttempt!;
  deps.runAttempt = async (...args) => {
    const out = await run(...args);
    if (args[1].id === "codex") { await writeProjectStrategy(ctx, repo.key, projectReferences(s, ["cursor"]), 1); out.attempt.limitHit = true; }
    return out;
  };
  const result = await runTask(ctx, task.id, deps);
  expect(result.attempts.map(a => a.executor)).toEqual(["codex", "cursor"]);
  expect(result.attempts.map(a => a.routing?.policy?.rev)).toEqual([1, 2]);
});

test("removing a queued override restores global routing before reservation", async () => {
  const { ctx, repo, deps } = await setup(), task = queueTask(ctx);
  updateTask(ctx, task.id, t => { t.queue = { reason: "paused", since: ctx.now, position: 1 }; });
  const status = deps.computeStatus; let changed = false;
  deps.computeStatus = async (...args) => { if (!changed) { changed = true; await writeProjectStrategy(ctx, repo.key, null, 1); } return status(...args); };
  await drainQueue(ctx, () => 123456789, deps);
  expect(listTasksWhere(ctx, {})[0].executor).toBe("codex");
});
test("exhausting the allowlist never falls back to a healthy global executor", async () => {
  const { ctx, deps } = await setup(), task = queueTask(ctx);
  const run = deps.runAttempt!;
  deps.runAttempt = async (...args) => { const out = await run(...args); out.attempt.limitHit = true; return out; };
  const result = await runTask(ctx, task.id, deps);
  expect(result.attempts.map(a => a.executor)).toEqual(["cursor"]);
  expect(result.state).toBe("limit");
});
test("unresolved low-level delegation cannot silently use global routing", async () => {
  const { ctx, s } = await setup(); let spawned = false;
  expect(() => delegate(ctx, { brief: { goal: "work", repo: ctx.home } }, () => { spawned = true; return 1; }, s)).toThrow("Resolve the repository");
  expect(spawned).toBe(false);
});

test("four allowed runners still respect the three-attempt limit", async () => {
  const { validateStrategy } = await import("../src/config/strategy");
  const ctx = fakeCtx(), s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {}, agy: {}, opencode: { via: "opencode", usage: "unmetered", model: "test/model" } }, pacing: { policy: "priority" } }, "test");
  const repo = await resolveRepo(ctx, ctx.home);
  await writeProjectStrategy(ctx, repo.key, projectReferences(s, ["codex", "cursor", "agy", "opencode"]), 0);
  const deps = { ...queueDeps(s), hooks: defaultHooks }, run = deps.runAttempt!;
  deps.runAttempt = async (...args) => { const out = await run(...args); out.attempt.limitHit = true; return out; };
  const result = await runTask(ctx, queueTask(ctx).id, deps);
  expect(result.attempts.map(a => a.executor)).toEqual(["codex", "cursor", "agy"]);
  expect(result.result?.report).toContain("attempt limit reached (3)");
});

test("queued project work explains when all configured choices disappear", async () => {
  const {ctx,s,deps}=await setup(),task=queueTask(ctx);
  updateTask(ctx,task.id,t=>{t.queue={reason:"no_slot",since:ctx.now,position:1};});
  delete s.runners.cursor; delete s.providers.cursor;
  let spawned=0; await drainQueue(ctx,()=>{spawned++;return 1;},deps);
  const result=listTasksWhere(ctx,{})[0];
  expect(spawned).toBe(0); expect(result.state).toBe("limit");
  expect(result.result?.report).toContain("no project executor available");
  expect(result.result?.report).toContain("not configured");
});
