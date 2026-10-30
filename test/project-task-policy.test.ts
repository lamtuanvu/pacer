import { expect, test } from "bun:test";
import { writeProjectStrategy } from "../src/config/project-strategies";
import { projectReferences } from "../src/engine/project-routing";
import { repoFor, resolveRepo, removeRepo } from "../src/core/repos";
import { defaultHooks } from "../src/classify/hooks";
import { delegate } from "../src/tasks/api";
import { runTask } from "../src/tasks/runner";
import { drainQueue } from "../src/tasks/drain";
import { listTasksWhere, updateTask } from "../src/tasks/store";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import { queueDeps, queueStrategy, queueTask } from "./queue-helpers";

async function setup(ids = ["cursor"]) {
  const ctx = fakeCtx({home:gitRepo(),run:realRun}), s = queueStrategy(true), repo = await resolveRepo(ctx, ctx.home);
  await writeProjectStrategy(ctx, repo.key, projectReferences(s, ids), 0);
  return { ctx, s, repo, deps: { ...queueDeps(s), hooks: defaultHooks } };
}
test("forbidden explicit delegation including force fails before creation or spawn", async () => {
  const { ctx, s, repo } = await setup(); let spawned = 0;
  for (const force of [false, true]) await expect(delegate(ctx, { brief: { goal: "work", repo: ctx.home }, repoRef: repo, executor: "codex", force }, () => { spawned++; return 1; }, s)).rejects.toThrow("project policy");
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
  const { ctx, s, repo } = await setup(); let spawned = false;
  await removeRepo(ctx,repo.key);
  await expect(delegate(ctx, { brief: { goal: "work", repo: ctx.home } }, () => { spawned = true; return 1; }, s)).rejects.toThrow("Resolve the repository");
  expect(spawned).toBe(false);
});

test("four allowed runners still respect the three-attempt limit", async () => {
  const { validateStrategy } = await import("../src/config/strategy");
  const ctx = fakeCtx({home:gitRepo(),run:realRun}), s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {}, agy: {}, opencode: { via: "opencode", usage: "unmetered", model: "test/model" } }, pacing: { policy: "priority" } }, "test");
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

for (const phase of ["runner", "drain", "retry"] as const) {
  test(`${phase} retains saved identity after registry removal and failed Git probes`, async () => {
    const {ctx,s,repo,deps} = await setup(), task = queueTask(ctx);
    updateTask(ctx,task.id,t => { t.repo=repo; t.queue={reason:"paused",since:ctx.now,position:1}; });
    await removeRepo(ctx,repo.key);
    ctx.run=async () => ({code:128,stdout:"",stderr:"cannot read repository"});
    if (phase === "runner") {
      const result=await runTask(ctx,task.id,deps);
      expect(result.repo?.key).toBe(repo.key);
      expect(result.attempts.map(a=>a.executor)).toEqual(["cursor"]);
    } else if (phase === "drain") {
      await drainQueue(ctx,()=>123456789,deps);
      expect(listTasksWhere(ctx,{})[0].executor).toBe("cursor");
    } else {
      const {retry}=await import("../src/core/tasks");
      updateTask(ctx,task.id,t=>{t.state="failed";delete t.queue;});
      await expect(retry(ctx,task.id,{executor:"codex"},{delegate:(c,input)=>delegate(c,input,()=>1,s)})).rejects.toMatchObject({code:"not_allowed"});
      expect(listTasksWhere(ctx,{})).toHaveLength(1);
    }
  });
}
test("unknown legacy task fails closed when Git cannot establish policy identity", async () => {
  const {ctx,deps,repo}=await setup(),task=queueTask(ctx);
  await removeRepo(ctx,repo.key);
  ctx.run=async()=>({code:128,stdout:"",stderr:"cannot read repository"});
  const result=await runTask(ctx,task.id,deps);
  expect(result.attempts).toHaveLength(0);
  expect(result.result?.report).toContain("Cannot establish repository identity");
});

test("a project policy created during identity lookup cannot authorize global routing", async () => {
  const {ctx,s,repo,deps}=await setup();
  await writeProjectStrategy(ctx,repo.key,null,1);
  await removeRepo(ctx,repo.key);
  const task=queueTask(ctx); let added=false;
  ctx.run=async()=>{if(!added){added=true;await writeProjectStrategy(ctx,repo.key,projectReferences(s,["cursor"]),2);}return {code:128,stdout:"",stderr:"cannot read Git"};};
  const result=await runTask(ctx,task.id,deps);
  expect(result.attempts).toHaveLength(0);
  expect(result.result?.report).toContain("Cannot establish repository identity");
});
test("an unresolved global identity is rechecked when policy appears before reservation", async () => {
  const {ctx,s,repo,deps}=await setup();
  await writeProjectStrategy(ctx,repo.key,null,1);
  await removeRepo(ctx,repo.key);
  ctx.run=async()=>({code:128,stdout:"",stderr:"cannot read Git"});
  const status=deps.computeStatus;
  deps.computeStatus=async(...args)=>{await writeProjectStrategy(ctx,repo.key,projectReferences(s,["cursor"]),2);return status(...args);};
  const result=await runTask(ctx,queueTask(ctx).id,deps);
  expect(result.attempts).toHaveLength(0);
  expect(result.result?.report).toContain("Cannot establish repository identity");
});

test("failed origin lookup stays unverified when policy is concurrently created",async()=>{
  const ctx=fakeCtx({home:gitRepo(),run:realRun}),s=queueStrategy(true),deps={...queueDeps(s),hooks:defaultHooks};
  await realRun(["git","-C",ctx.home,"remote","add","origin","git@github.com:example/origin-race.git"],10000);
  const repo=await resolveRepo(ctx,ctx.home);await removeRepo(ctx,repo.key);
  ctx.run=async(argv,ms,o)=>{
    if(argv.includes("rev-parse"))return realRun(argv,ms,o);
    if(argv.includes("get-url"))await writeProjectStrategy(ctx,repo.key,projectReferences(s,["cursor"]),0);
    return {code:128,stdout:"",stderr:"cannot read origin"};
  };
  const result=await runTask(ctx,queueTask(ctx).id,deps);
  expect(result.attempts).toHaveLength(0);
  expect(result.result?.report).toContain("Cannot establish repository identity");
});
