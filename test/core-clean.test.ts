import { persistTaskDiff } from "../src/tasks/diff";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitInfo } from "../src/core/git";
import * as tasks from "../src/core/tasks";
import { createTaskWorktree, taskWorktreesDir } from "../src/supervisor/worktree";
import { createTask, readTask, updateTask } from "../src/tasks/store";
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

test("clean removes an Orca worktree through the execution adapter", async () => {
  const {ctx, t, w, repo} = await finished();
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
  expect(existsSync(join(ctx.home, ".claude.json"))).toBe(false);
  expect(await tasks.clean(ctx)).toEqual({removed: [], kept: []});
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

test("clean reports an Orca worktree whose run files could not be pruned, and a rerun prunes them", async () => {
  const {ctx, t, w, repo} = await finished();
  updateTask(ctx, t.id, x => {
    x.result = {status: "done", executor: "codex", model: null, files: "", report: "", backend: "orca", worktree: w.path};
    x.placement = {requested: "new", mode: "new", why: "test"};
  });
  ctx.run = async (argv, timeout) => {
    if (argv[0] !== "orca") return realRun(argv, timeout);
    if (argv[2] === "show") return {code: 0, stdout: JSON.stringify({ok: true, result: {worktree: {
      id: `repo-id::${w.path}`, path: w.path, displayName: `pacer-${t.id}-codex`, isMainWorktree: false,
    }}}), stderr: ""};
    const removed = await realRun(["git", "-C", repo, "worktree", "remove", w.path], timeout);
    return {code: removed.code, stdout: '{"ok":true,"result":{}}', stderr: removed.stderr};
  };
  const rd = join(ctx.pacerHome, "runs", t.id, "1");
  writeFileSync(join(rd, "stdout"), "disposable");
  chmodSync(rd, 0o500);
  try {
    const r = await tasks.clean(ctx);
    expect(r.removed).toEqual([]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.reason).toStartWith("worktree deleted; run files could not be pruned: ");
    expect(existsSync(w.path)).toBe(false);
    expect(existsSync(join(rd, "stdout"))).toBe(true);
  } finally { chmodSync(rd, 0o700); }
  expect(await tasks.clean(ctx)).toEqual({removed: [], kept: []});
  expect(existsSync(join(rd, "stdout"))).toBe(false);
});

async function finishedIn(ctx: ReturnType<typeof fakeCtx>, o: { dirty?: boolean } = {}) {
  const repo = gitRepo();
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const info = await gitInfo(realRun, repo); if ("error" in info) throw new Error(info.error);
  const w = await createTaskWorktree(ctx, info, t.id, "main"); if ("error" in w) throw new Error(w.error);
  if (o.dirty) writeFileSync(join(w.path, "wip.txt"), "x");
  const rd = join(ctx.pacerHome, "runs", t.id, "1"); mkdirSync(rd, { recursive: true });
  writeFileSync(join(rd, "stdout"), "disposable");
  updateTask(ctx, t.id, (x) => {
    x.state = "done"; x.worktree = w.workdir;
    x.run = { dir: rd, attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: w.workdir, logFile: "" };
    x.review = { accepted: true, kind: null, note: null, at: 1 };
  });
  return { t, w, repo, rd };
}

const MISSING = "source repository is missing; use --force to delete the worktree";

test("clean keeps a task whose repository was deleted and still cleans the others", async () => {
  const ctx = fakeCtx({ run: realRun });
  const gone = await finishedIn(ctx, { dirty: true }), ok = await finishedIn(ctx);
  rmSync(gone.repo, { recursive: true, force: true });
  const dry = await tasks.clean(ctx, { dryRun: true });
  expect(dry).toEqual({ removed: [ok.t.id], kept: [{ id: gone.t.id, reason: MISSING }] });
  expect(existsSync(ok.w.path)).toBe(true);
  expect(await tasks.clean(ctx)).toEqual({ removed: [ok.t.id], kept: [{ id: gone.t.id, reason: MISSING }] });
  expect(existsSync(ok.w.path)).toBe(false);
  expect(existsSync(gone.w.path)).toBe(true);
  expect(existsSync(join(gone.rd, "stdout"))).toBe(true);
});

test("clean --force deletes the worktree of a deleted repository; --dry-run changes nothing", async () => {
  const ctx = fakeCtx({ run: realRun });
  const gone = await finishedIn(ctx, { dirty: true });
  rmSync(gone.repo, { recursive: true, force: true });
  expect(await tasks.clean(ctx, { force: true, dryRun: true })).toEqual({ removed: [gone.t.id], kept: [] });
  expect(existsSync(gone.w.path)).toBe(true);
  expect(await tasks.clean(ctx, { force: true })).toEqual({ removed: [gone.t.id], kept: [] });
  expect(existsSync(gone.w.path)).toBe(false);
  expect(existsSync(join(gone.rd, "stdout"))).toBe(false);
  expect(await tasks.clean(ctx, { force: true })).toEqual({ removed: [], kept: [] });
});

test("clean prunes leftover run files of a task whose repository and worktree are both gone, then skips it", async () => {
  const ctx = fakeCtx({ run: realRun });
  const gone = await finishedIn(ctx);
  rmSync(gone.repo, { recursive: true, force: true });
  rmSync(gone.w.path, { recursive: true, force: true });
  expect(await tasks.clean(ctx, { dryRun: true })).toEqual({ removed: [gone.t.id], kept: [] });
  expect(existsSync(join(gone.rd, "stdout"))).toBe(true);
  expect(await tasks.clean(ctx)).toEqual({ removed: [gone.t.id], kept: [] });
  expect(existsSync(join(gone.rd, "stdout"))).toBe(false);
  expect(await tasks.clean(ctx)).toEqual({ removed: [], kept: [] });
  expect(await tasks.clean(ctx, { force: true })).toEqual({ removed: [], kept: [] });
});

test("clean skips a task whose worktree is gone and has no run files", async () => {
  const ctx = fakeCtx({ run: realRun });
  const gone = await finishedIn(ctx);
  rmSync(gone.w.path, { recursive: true, force: true });
  rmSync(dirname(gone.rd), { recursive: true, force: true });
  expect(await tasks.clean(ctx, { force: true })).toEqual({ removed: [], kept: [] });
});

test("clean --force reports a deleted worktree whose run files could not be pruned, and a rerun prunes them", async () => {
  const ctx = fakeCtx({ run: realRun });
  const gone = await finishedIn(ctx);
  rmSync(gone.repo, { recursive: true, force: true });
  chmodSync(gone.rd, 0o500);
  try {
    const r = await tasks.clean(ctx, { force: true });
    expect(r.removed).toEqual([]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.reason).toStartWith("worktree deleted; run files could not be pruned: ");
    expect(existsSync(gone.w.path)).toBe(false);
    expect(existsSync(join(gone.rd, "stdout"))).toBe(true);
  } finally { chmodSync(gone.rd, 0o700); }
  expect(await tasks.clean(ctx, { dryRun: true })).toEqual({ removed: [gone.t.id], kept: [] });
  expect(existsSync(join(gone.rd, "stdout"))).toBe(true);
  expect(await tasks.clean(ctx)).toEqual({ removed: [gone.t.id], kept: [] });
  expect(existsSync(join(gone.rd, "stdout"))).toBe(false);
  expect(await tasks.clean(ctx)).toEqual({ removed: [], kept: [] });
});

const NOT_OWN = "worktree path is not this task's worktree; not deleted";

/** A forced clean of a deleted repository whose saved workdir is not the task's own worktree deletes nothing. */
async function adversarial(name: string, workdir: (o: { root: string; tag: string; id: string; outside: string; sibling: string }) => string) {
  for (const dryRun of [true, false]) test(`clean --force${dryRun ? " --dry-run" : ""} deletes nothing for a ${name} workdir`, async () => {
    const ctx = fakeCtx({ run: realRun });
    const gone = await finishedIn(ctx);
    rmSync(gone.repo, { recursive: true, force: true });
    const root = taskWorktreesDir(ctx), tagDir = dirname(gone.w.path), tag = tagDir.slice(root.length + 1);
    const sibling = join(tagDir, "t-20260101-000000-0000"), outside = join(ctx.pacerHome, "outside");
    mkdirSync(join(sibling), { recursive: true }); mkdirSync(join(outside, gone.t.id), { recursive: true });
    const sentinels = [join(root, "s"), join(tagDir, "s"), join(sibling, "s"), join(outside, "s"), join(outside, gone.t.id, "s"), join(gone.w.path, "s")];
    for (const s of sentinels) writeFileSync(s, "keep");
    const wd = workdir({ root, tag, id: gone.t.id, outside, sibling });
    updateTask(ctx, gone.t.id, x => { x.worktree = wd; x.run!.workdir = wd; });
    expect(await tasks.clean(ctx, { force: true, dryRun })).toEqual({ removed: [], kept: [{ id: gone.t.id, reason: NOT_OWN }] });
    for (const s of sentinels) expect(existsSync(s)).toBe(true);
    expect(existsSync(join(gone.rd, "stdout"))).toBe(true);
  });
}

adversarial("root", o => o.root);
adversarial("root with a trailing slash", o => o.root + "/");
adversarial("repo-tag-only", o => join(o.root, o.tag));
adversarial("sibling task's", o => o.sibling);
adversarial("'..' traversal inside the root", o => `${o.root}/${o.tag}/../${o.tag}/${o.id}`);
adversarial("'..' traversal escaping the root", o => `${o.root}/../outside/${o.id}`);
adversarial("symlinked repo-tag", o => {
  const tag = `${o.tag}-link`; symlinkSync(o.outside, join(o.root, tag)); return join(o.root, tag, o.id);
});
adversarial("symlinked task directory", o => {
  const tag = `${o.tag}-x`; mkdirSync(join(o.root, tag)); symlinkSync(join(o.outside, o.id), join(o.root, tag, o.id)); return join(o.root, tag, o.id);
});

for (const dryRun of [true, false]) test(`clean --force${dryRun ? " --dry-run" : ""} deletes nothing when the worktrees folder is a symlink`, async () => {
  const ctx = fakeCtx({ run: realRun });
  const gone = await finishedIn(ctx);
  rmSync(gone.repo, { recursive: true, force: true });
  const root = taskWorktreesDir(ctx), tag = dirname(gone.w.path).slice(root.length + 1), outside = join(ctx.pacerHome, "outside");
  renameSync(root, outside); symlinkSync(outside, root);
  const sentinels = [join(outside, "s"), join(outside, tag, "s"), join(outside, tag, gone.t.id, "s")];
  for (const s of sentinels) writeFileSync(s, "keep");
  expect(await tasks.clean(ctx, { force: true, dryRun })).toEqual({ removed: [], kept: [{ id: gone.t.id, reason: "worktrees folder is a symlink; not deleted" }] });
  for (const s of sentinels) expect(existsSync(s)).toBe(true);
  expect(existsSync(join(gone.rd, "stdout"))).toBe(true);
});

for (const dryRun of [true, false]) test(`clean${dryRun ? " --dry-run" : ""} removes a worktree through git when the worktrees folder is a symlink`, async () => {
  const ctx = fakeCtx({ run: realRun });
  const root = taskWorktreesDir(ctx), moved = join(ctx.pacerHome, "moved-worktrees");
  mkdirSync(moved, { recursive: true }); mkdirSync(dirname(root), { recursive: true }); symlinkSync(moved, root);
  const ok = await finishedIn(ctx), tag = dirname(ok.w.path).slice(root.length + 1);
  const sibling = join(moved, tag, "t-20260101-000000-0000"); mkdirSync(sibling);
  const sentinels = [join(moved, "s"), join(moved, tag, "s"), join(sibling, "s")];
  for (const s of sentinels) writeFileSync(s, "keep");
  expect(await tasks.clean(ctx, { dryRun })).toEqual({ removed: [ok.t.id], kept: [] });
  for (const s of sentinels) expect(existsSync(s)).toBe(true);
  expect(existsSync(ok.w.path)).toBe(dryRun);
  expect(existsSync(join(ok.rd, "stdout"))).toBe(dryRun);
  if (!dryRun) expect(Bun.spawnSync(["git", "-C", ok.repo, "worktree", "list"]).stdout.toString()).not.toContain(ok.t.id);
});

test("clean --force prunes run files of a gone worktree and deleted repository under a symlinked worktrees folder", async () => {
  const ctx = fakeCtx({ run: realRun });
  const root = taskWorktreesDir(ctx), moved = join(ctx.pacerHome, "moved-worktrees");
  mkdirSync(moved, { recursive: true }); mkdirSync(dirname(root), { recursive: true }); symlinkSync(moved, root);
  const gone = await finishedIn(ctx);
  rmSync(gone.repo, { recursive: true, force: true }); rmSync(gone.w.path, { recursive: true, force: true });
  expect(await tasks.clean(ctx, { force: true })).toEqual({ removed: [gone.t.id], kept: [] });
  expect(existsSync(join(gone.rd, "stdout"))).toBe(false);
  expect(await tasks.clean(ctx, { force: true })).toEqual({ removed: [], kept: [] });
});

for (const dryRun of [true, false]) test(`clean --force${dryRun ? " --dry-run" : ""} deletes nothing when the repo-tag folder becomes a symlink after verification`, async () => {
  const ctx = fakeCtx({ run: realRun });
  const gone = await finishedIn(ctx);
  rmSync(gone.repo, { recursive: true, force: true });
  const tagDir = dirname(gone.w.path), moved = `${tagDir}.orig`, outside = join(ctx.pacerHome, "outside");
  mkdirSync(join(outside, gone.t.id), { recursive: true });
  const sentinels = [join(outside, "s"), join(outside, gone.t.id, "s"), join(moved, gone.t.id, "s")];
  writeFileSync(join(gone.w.path, "s"), "keep");
  for (const s of sentinels.slice(0, 2)) writeFileSync(s, "keep");
  tasks.cleanTestHooks.beforeRecheck = () => { renameSync(tagDir, moved); symlinkSync(outside, tagDir); };
  try {
    expect(await tasks.clean(ctx, { force: true, dryRun })).toEqual({ removed: [], kept: [{ id: gone.t.id, reason: "worktree changed during cleanup; not deleted" }] });
  } finally { delete tasks.cleanTestHooks.beforeRecheck; }
  for (const s of sentinels) expect(existsSync(s)).toBe(true);
  expect(existsSync(join(gone.rd, "stdout"))).toBe(true);
});

test("clean --force deletes nothing outside the worktrees folder when the repo-tag folder becomes a symlink after the re-check", async () => {
  const ctx = fakeCtx({ run: realRun });
  const gone = await finishedIn(ctx);
  rmSync(gone.repo, { recursive: true, force: true });
  const root = taskWorktreesDir(ctx), tagDir = dirname(gone.w.path), moved = `${tagDir}.orig`, outside = join(ctx.pacerHome, "outside");
  mkdirSync(join(outside, gone.t.id), { recursive: true });
  const sentinels = [join(outside, "s"), join(outside, gone.t.id, "s"), join(moved, gone.t.id, "s")];
  writeFileSync(join(gone.w.path, "s"), "keep");
  for (const s of sentinels.slice(0, 2)) writeFileSync(s, "keep");
  tasks.cleanTestHooks.beforeRename = () => { renameSync(tagDir, moved); symlinkSync(outside, tagDir); };
  try {
    expect(await tasks.clean(ctx, { force: true })).toEqual({ removed: [], kept: [{ id: gone.t.id, reason: "worktree changed during cleanup; not deleted" }] });
  } finally { delete tasks.cleanTestHooks.beforeRename; }
  for (const s of sentinels) expect(existsSync(s)).toBe(true);
  expect(readdirSync(root).filter(n => n.startsWith(".pacer-delete-"))).toEqual([]);
  expect(existsSync(join(gone.rd, "stdout"))).toBe(true);
});

test("clean --force keeps the task and deletes nothing when the worktree cannot be moved aside", async () => {
  const ctx = fakeCtx({ run: realRun });
  const gone = await finishedIn(ctx);
  rmSync(gone.repo, { recursive: true, force: true });
  const tagDir = dirname(gone.w.path), sentinel = join(gone.w.path, "s");
  writeFileSync(sentinel, "keep");
  chmodSync(tagDir, 0o500);
  try {
    expect(await tasks.clean(ctx, { force: true })).toEqual({ removed: [], kept: [{ id: gone.t.id, reason: "worktree changed during cleanup; not deleted" }] });
  } finally { chmodSync(tagDir, 0o700); }
  expect(existsSync(sentinel)).toBe(true);
  expect(existsSync(join(gone.rd, "stdout"))).toBe(true);
  expect(await tasks.clean(ctx, { force: true })).toEqual({ removed: [gone.t.id], kept: [] });
  expect(existsSync(gone.w.path)).toBe(false);
});

for (const dryRun of [true, false]) test(`clean${dryRun ? " --dry-run" : ""} reports a leftover folder from an interrupted forced clean and does not delete it`, async () => {
  const ctx = fakeCtx({ run: realRun });
  const ok = await finishedIn(ctx), root = taskWorktreesDir(ctx);
  const name = ".pacer-delete-t-20260101-000000-0000-0123456789abcdef", sentinel = join(root, name, "s");
  mkdirSync(join(root, name)); writeFileSync(sentinel, "keep");
  expect(await tasks.clean(ctx, { dryRun })).toEqual({ removed: [ok.t.id], kept: [{ id: name, reason: `unfinished forced cleanup; not deleted, remove ${join(root, name)} by hand` }] });
  expect(existsSync(sentinel)).toBe(true);
});

test("clean keeps a remote task whose local repository was deleted", async () => {
  const ctx = fakeCtx({ run: realRun });
  const gone = await finishedIn(ctx);
  updateTask(ctx, gone.t.id, x => { x.run!.host = "box"; });
  rmSync(gone.repo, { recursive: true, force: true });
  expect(await tasks.clean(ctx, { force: true })).toEqual({ removed: [], kept: [{ id: gone.t.id, reason: "source repository is missing; remote cleanup needs it" }] });
});
