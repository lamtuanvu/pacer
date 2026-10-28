import { persistTaskDiff } from "../src/tasks/diff";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitInfo } from "../src/core/git";
import * as tasks from "../src/core/tasks";
import { createTaskWorktree } from "../src/supervisor/worktree";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { trustClaudeWorktree } from "../src/exec/claude-trust";
import { fakeCtx, gitRepo, realRun } from "./helpers";

async function finished(o: { dirty?: boolean; reviewed?: boolean } = {}) {
  const ctx = fakeCtx({ run: realRun }), repo = gitRepo();
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const info = await gitInfo(realRun, repo); if ("error" in info) throw new Error(info.error);
  const w = await createTaskWorktree(ctx, info, t.id, "main"); if ("error" in w) throw new Error(w.error);
  if (o.dirty) writeFileSync(join(w.path, "wip.txt"), "x");
  const rd = join(ctx.pacerHome, "runs", t.id, "1"); mkdirSync(rd, { recursive: true });
  updateTask(ctx, t.id, (x) => {
    x.state = "done"; x.worktree = w.workdir;
    x.run = { dir: rd, attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: w.workdir, logFile: "" };
    if (o.reviewed !== false) x.review = { accepted: true, kind: null, note: null, at: 1 };
  });
  return { ctx, t, w, repo };
}

test("clean removes reviewed task worktrees, keeps review evidence and the branch", async () => {
  const { ctx, t, w, repo } = await finished();
  writeFileSync(join(w.path, "change.txt"), "review me\n");
  expect(Bun.spawnSync(["git", "-C", w.path, "add", "."]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", w.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "change"]).exitCode).toBe(0);
  updateTask(ctx, t.id, x => { x.baseBranch = "main"; });
  await persistTaskDiff(ctx, readTask(ctx, t.id)!);
  writeFileSync(join(ctx.pacerHome, "runs", t.id, "1", "stdout"), "disposable");
  const before = await tasks.diff(ctx, t.id);
  expect(before.patch).toContain("+review me");
  expect(await tasks.clean(ctx)).toEqual({ removed: [t.id], kept: [] });
  expect(existsSync(w.path)).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "runs", t.id, "1", "diff.json"))).toBe(true);
  expect(await tasks.diff(ctx, t.id)).toEqual(before);
  expect(existsSync(join(ctx.pacerHome, "runs", t.id, "1", "stdout"))).toBe(false);
  expect(Bun.spawnSync(["git", "-C", repo, "rev-parse", "--verify", `pacer/${t.id}`]).exitCode).toBe(0);
});

test("clean keeps dirty worktrees without --force", async () => {
  const { ctx, t, w } = await finished({ dirty: true });
  expect(await tasks.clean(ctx)).toEqual({ removed: [], kept: [{ id: t.id, reason: "uncommitted changes; use --force" }] });
  expect(existsSync(w.path)).toBe(true);
  expect((await tasks.clean(ctx, { force: true })).removed).toEqual([t.id]);
});

test("clean leaves unreviewed tasks and honours --dry-run", async () => {
  const a = await finished({ reviewed: false });
  expect(await tasks.clean(a.ctx)).toEqual({ removed: [], kept: [] });
  const b = await finished();
  expect(await tasks.clean(b.ctx, { dryRun: true })).toEqual({ removed: [b.t.id], kept: [] });
  expect(existsSync(b.w.path)).toBe(true);
});

test("clean prunes settled in-place recordings, preserves logs and respects dry-run", async () => {
  const ctx=fakeCtx();
  const cases=[{state:"done",review:true,prune:true},{state:"failed",dismissed:true,prune:true},{state:"done",resolved:true,prune:true},{state:"running",review:true,prune:false},{state:"done",prune:false}] as const;
  const fixtures=cases.map(c=>{
    const t=createTask(ctx,{brief:{goal:"g",repo:"."},kind:null,requestedExecutor:null,timeoutS:60});
    updateTask(ctx,t.id,x=>{x.state=c.state;
      x.run={dir:join(ctx.pacerHome,"runs",t.id,"1"),attempt:1,executor:"codex",startedAt:1,mode:"current",workdir:".",logFile:""};
      if("review" in c)x.review={accepted:true,kind:null,note:null,at:1};if("dismissed" in c)x.dismissed=true;if("resolved" in c)x.resolved="resolved";});
    const dir=join(ctx.pacerHome,"runs",t.id,"1");mkdirSync(dir,{recursive:true});
    for(const name of ["session.log","session.log.1","session.ckpt","stdout","stderr","exit"])writeFileSync(join(dir,name),"retained");
    return {dir,prune:c.prune};
  });
  await tasks.clean(ctx,{dryRun:true});
  for(const {dir} of fixtures)expect(existsSync(join(dir,"session.log"))).toBe(true);
  await tasks.clean(ctx);
  for(const {dir,prune} of fixtures){
    for(const name of ["session.log","session.log.1","session.ckpt"])expect(existsSync(join(dir,name))).toBe(!prune);
    for(const name of ["stdout","stderr","exit"])expect(existsSync(join(dir,name))).toBe(true);
  }
});

test("clean removes an Orca worktree and its pacer-added Claude trust", async () => {
  const {ctx, t, w, repo} = await finished();
  const config = join(ctx.home, ".claude.json");
  trustClaudeWorktree(ctx, w.path, config, t.id);
  updateTask(ctx, t.id, x => {
    x.result = {status: "done", executor: "claude-code", model: null, files: "", report: "", backend: "orca", worktree: w.path};
    x.placement = {requested: "new", mode: "new", why: "test"};
  });
  const calls: string[][] = [];
  ctx.run = async (argv, timeout) => {
    if (argv[0] !== "orca") return realRun(argv, timeout);
    calls.push(argv);
    if (argv[2] === "show") return {code: 0, stdout: JSON.stringify({ok: true, result: {worktree: {
      id: `repo-id::${w.path}`, path: w.path, displayName: `pacer-${t.id}-claude-code`, isMainWorktree: false,
    }}}), stderr: ""};
    const removed = await realRun(["git", "-C", repo, "worktree", "remove", w.path], timeout);
    return {code: removed.code, stdout: '{"ok":true,"result":{}}', stderr: removed.stderr};
  };
  expect((await tasks.clean(ctx)).removed).toEqual([t.id]);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(["orca", "worktree", "rm", "--worktree", `id:repo-id::${w.path}`, "--json"]);
  expect(existsSync(w.path)).toBe(false);
  expect(JSON.parse(await Bun.file(config).text()).projects[w.path]).toBeUndefined();
});

test("clean keeps an Orca worktree whose ownership name changed", async () => {
  const {ctx, t, w} = await finished();
  updateTask(ctx, t.id, x => {
    x.result = {status: "done", executor: "codex", model: null, files: "", report: "", backend: "orca", worktree: w.path};
    x.placement = {requested: "new", mode: "new", why: "test"};
  });
  let removed = false;
  ctx.run = async (argv, timeout) => {
    if (argv[0] !== "orca") return realRun(argv, timeout);
    if (argv[2] === "rm") removed = true;
    return {code: 0, stdout: JSON.stringify({ok: true, result: {worktree: {id: `repo::${w.path}`, path: w.path, displayName: "someone-else"}}}), stderr: ""};
  };
  expect((await tasks.clean(ctx)).kept).toEqual([{id: t.id, reason: "Orca worktree ownership could not be verified"}]);
  expect(removed).toBe(false);
  expect(existsSync(w.path)).toBe(true);
});
