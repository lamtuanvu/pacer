import { expect, test } from "bun:test";
import { chmodSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { cliDeps, main } from "../src/cli";
import { resolveRepo } from "../src/core/repos";
import * as tasks from "../src/core/tasks";
import { blockExecutor } from "../src/executors/blocked";
import { markExhausted } from "../src/usage/reactive";
import { delegate } from "../src/tasks/api";
import { validateStrategy } from "../src/config/strategy";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { runTask } from "../src/tasks/runner";
import { defaultHooks } from "../src/classify/hooks";
import type { Status } from "../src/engine/status";
import { runAttempt } from "../src/exec/direct";
import { fakeCtx, gitRepo, realRun, tmpDir, withLoginIndicators } from "./helpers";

const strategy = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {} }, routing: [{ default: ["codex", "cursor"] }] }, "/x");
// Fake executors here answer headlessly.
for (const p of Object.values(strategy.providers)) p.session = "headless";
function executorCtx() {
  const bin = tmpDir(), path = join(bin, "cursor-agent");
  writeFileSync(path, '#!/bin/sh\n[ "$1" = create-chat ] && exit 1\ncat >/dev/null\necho executed\n');
  chmodSync(path, 0o755);
  return fakeCtx({ run: realRun, env: { PATH: `${bin}:${process.env.PATH}` } });
}
const strategyText = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n  cursor: {}\nexecution:\n  launch_mode: headless\n";

test("explicit CLI repo preserves the real linked checkout despite registry aliases", async () => {
  const ctx = fakeCtx({ run: realRun }), repo = gitRepo(), wt = join(tmpDir(), "linked"), link = join(tmpDir(), "alias");
  await realRun(["git", "-C", repo, "worktree", "add", "-b", "linked", wt], 10000);
  await resolveRepo(ctx, repo); await resolveRepo(ctx, wt);
  symlinkSync(wt, link);
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), strategyText);
  const original = cliDeps.spawnRunner;
  cliDeps.spawnRunner = () => 1;
  try {
    const r = await main(["delegate", "--goal", "g", "--repo", link, "--json"], ctx);
    expect(r.code).toBe(0);
    const t = JSON.parse(r.out);
    expect(t.repo.path).toBe(realpathSync(wt));
    expect(t.brief.repo).toBe(realpathSync(wt));
    const api = await callOp(ctx, "task.delegate", { goal: "API path", repo: link }, { spawnRunner: () => 1 }) as { task_id: string };
    expect(readTask(ctx, api.task_id)?.repo?.path).toBe(realpathSync(wt));
    expect(readTask(ctx, api.task_id)?.brief.repo).toBe(realpathSync(wt));
  } finally { cliDeps.spawnRunner = original; }
});

for (const mark of ["block", "exhausted"] as const) test(`fresh ${mark} during selection cannot launch or fall back to that executor`, async () => {
  const ctx = fakeCtx(), task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const launched: string[] = [];
  const result = await runTask(ctx, task.id, {
    loadStrategy: () => strategy,
    computeStatus: async () => ({ providers: Object.keys(strategy.providers).map(id => ({ id, usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false })) } as unknown as Status),
    hooks: { ...defaultHooks, filterExecutors: async (_c, _t, ids) => {
      if (mark === "block") blockExecutor(ctx, "codex#codex");
      else markExhausted(ctx, strategy.runners.codex.account, Date.now() / 1000 + 3600, { manual: true });
      return ids;
    } },
    runAttempt: async (_c, cfg) => {
      launched.push(cfg.id);
      return { exec: { code: 0, stdout: "", stderr: "", timedOut: false }, report: "done", attempt: { executor: cfg.id, model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" } };
    },
    verifyRepo: async () => ({ files: "" }),
  });
  expect(result.state).toBe("done");
  expect(launched).toEqual(["cursor"]);
});

test("explicit exhausted executor is refused before creating a task", () => {
  const ctx = fakeCtx();
  markExhausted(ctx, strategy.runners.codex.account, ctx.now + 3600, { manual: true });
  expect(() => delegate(ctx, { brief: { goal: "g", repo: ctx.home }, executor: "codex" }, () => 1, strategy)).toThrow(/exhausted/i);
});

test("review retry persists and executes in the original worktree with uncommitted work", async () => {
  const ctx = executorCtx(), repo = gitRepo(), wt = join(tmpDir(), "original");
  await realRun(["git", "-C", repo, "worktree", "add", "-b", "original", wt], 10000);
  writeFileSync(join(wt, "prior.txt"), "prior");
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), strategyText);
  const task = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "done"; t.worktree = wt; t.baseBranch = "main"; t.placement = { requested: "new", mode: "new" }; t.result = { status: "done", executor: "codex", model: null, files: "", report: "", backend: "direct", worktree: wt }; });
  let atSpawn: string | undefined;
  const r = await tasks.review(ctx, task.id, { verdict: "retry", executor: "cursor" }, { delegate: (c, i) => delegate(c, i, (cc, id) => { atSpawn = readTask(cc, id)?.worktree; return 1; }) });
  const retry = readTask(ctx, r.retry!.id)!;
  expect(atSpawn).toBe(wt);
  expect(retry.worktree).toBe(wt);
  const out = await runAttempt(ctx, strategy.providers.cursor, retry);
  expect(out.exec.code).toBe(0);
  expect(readTask(ctx, retry.id)?.worktree).toBe(wt);
});

test("new worktree fetches default remote tip instead of current feature HEAD and records SHA", async () => {
  const ctx = executorCtx(), origin = gitRepo(), repo = join(tmpDir(), "checkout");
  await realRun(["git", "clone", "-q", origin, repo], 10000);
  const stale = (await realRun(["git", "-C", repo, "rev-parse", "HEAD"], 10000)).stdout.trim();
  await realRun(["git", "-C", repo, "checkout", "-b", "stale-feature"], 10000);
  await realRun(["git", "-C", origin, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "advance"], 10000);
  const tip = (await realRun(["git", "-C", origin, "rev-parse", "HEAD"], 10000)).stdout.trim();
  const task = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const out = await runAttempt(ctx, strategy.providers.cursor, task);
  expect(out.exec.code).toBe(0);
  const created = readTask(ctx, task.id)!.worktree!;
  expect(created).toBeDefined();
  expect((await realRun(["git", "-C", created, "rev-parse", "HEAD"], 10000)).stdout.trim()).toBe(tip);
  expect(readTask(ctx, task.id)?.baseSha).toBe(tip);
  const original = cliDeps.spawnRunner;
  cliDeps.spawnRunner = () => 1;
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), strategyText);
  try {
    const r = await main(["delegate", "--goal", "head opt in", "--repo", repo, "--worktree", "new", "--worktree-base", "head", "--json"], ctx);
    expect(r.code).toBe(0);
    const t = readTask(ctx, JSON.parse(r.out).id)!;
    const headOut = await runAttempt(ctx, strategy.providers.cursor, t);
    expect(headOut.exec.code).toBe(0);
    expect((await realRun(["git", "-C", readTask(ctx, t.id)!.worktree!, "rev-parse", "HEAD"], 10000)).stdout.trim()).toBe(stale);
  } finally { cliDeps.spawnRunner = original; }
}, 30_000);

for (const id of ["codex", "codex#codex"]) test(`explicit blocked alias ${id} fails without spawning`, () => {
  const ctx = fakeCtx();
  blockExecutor(ctx, "codex#codex");
  expect(() => delegate(ctx, { brief: { goal: "g", repo: ctx.home }, executor: id }, () => { throw Error("must not spawn"); }, strategy)).toThrow(/Blocked by you/);
});

test("limit fallback cannot run an executor newly blocked by the preceding attempt", async () => {
  const ctx = fakeCtx(), task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const launched: string[] = [];
  const result = await runTask(ctx, task.id, {
    loadStrategy: () => strategy,
    computeStatus: async () => ({ providers: Object.keys(strategy.providers).map(id => ({ id, usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false })) } as unknown as Status),
    hooks: defaultHooks,
    runAttempt: async (_c, cfg) => {
      launched.push(cfg.id);
      blockExecutor(ctx, "cursor#cursor");
      return { exec: { code: 1, stdout: "rate limit reached", stderr: "", timedOut: false }, report: "rate limit reached", attempt: { executor: cfg.id, model: null, startedAt: 1, endedAt: 2, exitCode: 1, timedOut: false, limitHit: true, log: "" } };
    },
    verifyRepo: async () => ({ files: "" }),
  });
  expect(launched).toEqual(["codex"]);
  expect(result.state).toBe("limit");
});

test("missing origin refuses new worktrees and explains the HEAD opt-in", async () => {
  const ctx = executorCtx(), repo = gitRepo();
  const task = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  task.placement = { requested: "new" };
  const out = await runAttempt(ctx, strategy.providers.cursor, task);
  expect(out.exec.code).toBe(1);
  expect(out.report).toContain("cannot fetch origin");
  expect(out.report).toContain("--worktree-base head");
  expect(readTask(ctx, task.id)?.worktree).toBeUndefined();
});

test("automatic child placement in a local-only repo starts the executor and records HEAD", async () => {
  const ctx = executorCtx(), repo = gitRepo();
  const head = (await realRun(["git", "-C", repo, "rev-parse", "HEAD"], 10000)).stdout.trim();
  const task = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const out = await runAttempt(ctx, strategy.providers.cursor, task);
  expect(out.exec.code).toBe(0);
  expect(readTask(ctx, task.id)?.run).toBeDefined();
  expect(readTask(ctx, task.id)?.baseSha).toBe(head);
  expect(readTask(ctx, task.id)?.baseBranch).toBe("HEAD");
});

test("automatic placement never falls back to HEAD when origin fetch fails", async () => {
  const ctx = executorCtx(), repo = gitRepo();
  await realRun(["git", "-C", repo, "remote", "add", "origin", join(tmpDir(), "missing")], 10000);
  const task = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const out = await runAttempt(ctx, strategy.providers.cursor, task);
  expect(out.exec.code).toBe(1);
  expect(out.report).toContain("cannot fetch origin");
  expect(readTask(ctx, task.id)?.run).toBeUndefined();
});

test("explicit default base in a local-only repo requires origin", async () => {
  const ctx = executorCtx(), repo = gitRepo();
  const task = createTask(ctx, { brief: { goal: "g", repo, worktreeBase: "default" }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const out = await runAttempt(ctx, strategy.providers.cursor, task);
  expect(out.exec.code).toBe(1);
  expect(out.report).toContain("cannot fetch origin");
  expect(readTask(ctx, task.id)?.run).toBeUndefined();
});

test("clean retains a reviewed parent's worktree while its retry still needs it", async () => {
  const { createTaskWorktree } = await import("../src/supervisor/worktree");
  const { gitInfo } = await import("../src/core/git");
  const ctx = fakeCtx({ run: realRun }), repo = gitRepo();
  const parent = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const info = await gitInfo(realRun, repo);
  if ("error" in info) throw Error(info.error);
  const worktree = await createTaskWorktree(ctx, info, parent.id, "main");
  if ("error" in worktree) throw Error(worktree.error);
  updateTask(ctx, parent.id, t => {
    t.state = "done"; t.worktree = worktree.workdir;
    t.review = { accepted: false, kind: null, note: null, at: ctx.now };
    t.run = { dir: ctx.pacerHome, attempt: 1, executor: "codex", startedAt: ctx.now, mode: "new", workdir: worktree.workdir, logFile: "" };
  });
  const retry = createTask(ctx, { brief: parent.brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, retry.id, t => { t.retryOf = parent.id; t.worktree = worktree.workdir; });
  const cleaned = await tasks.clean(ctx, { force: true });
  expect(cleaned.removed).toEqual([]);
  expect(cleaned.kept).toContainEqual({ id: parent.id, reason: "worktree is shared with an active or unreviewed task" });
});

for (const mark of ["block", "exhausted"] as const) test(`queue drain cannot reserve a ${mark} executor from stale status`, async () => {
  const { drainQueue } = await import("../src/tasks/drain");
  const ctx = fakeCtx(), task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.queue = { reason: "no_slot", since: ctx.now, position: 1 }; });
  if (mark === "block") blockExecutor(ctx, "codex#codex");
  else markExhausted(ctx, strategy.runners.codex.account, ctx.now + 3600, { manual: true });
  const spawned: string[] = [];
  await drainQueue(ctx, (_c, id) => { spawned.push(id); return 1; }, {
    loadStrategy: () => strategy,
    computeStatus: async () => ({ providers: Object.keys(strategy.providers).map(id => ({ id, usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false })) } as unknown as Status),
    hooks: defaultHooks,
  });
  expect(spawned).toEqual([]);
  expect(readTask(ctx, task.id)?.state).toBe("queued");
});

test("explicit conversation runs on its planner account even when delegation routes elsewhere", async () => {
  const ctx=withLoginIndicators(fakeCtx({run:realRun,env:{PATH:process.env.PATH}})), repo=gitRepo();
  const task=createTask(ctx,{brief:{goal:"Talk",repo},kind:null,requestedExecutor:"claude-code",timeoutS:60,interactionMode:"conversation"});
  const launched:string[]=[];
  const result=await runTask(ctx,task.id,{
    loadStrategy:()=>strategy,
    computeStatus:async()=>({providers:Object.keys(strategy.providers).map(id=>({id,usage:"reactive",windows:[],binding:null,verdict:"OK",installed:true,stale:false}))} as unknown as Status),
    hooks:defaultHooks,
    runAttempt:async(_c,cfg)=>{launched.push(cfg.id);return {exec:{code:0,stdout:"",stderr:"",timedOut:false},report:"Turn ended",attempt:{executor:cfg.id,model:null,startedAt:1,endedAt:2,exitCode:0,timedOut:false,limitHit:false,log:""}};},
    verifyRepo:async()=>({files:""}),
  });
  expect(launched).toEqual(["claude-code"]);
  expect(result.state).not.toBe("queued");
});
