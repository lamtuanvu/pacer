import {expect, test} from "bun:test";
import {mkdirSync, rmSync} from "node:fs";
import {join} from "node:path";
import {cleanOrcaTask} from "../src/exec/orca/cleanup";
import {createTask, readTask, updateTask} from "../src/tasks/store";
import {fakeCtx} from "./helpers";
import {fakeRun, raw} from "./fixtures/orca/fake";

const envelope = (result: object) => raw(JSON.stringify({ok: true, result}));

function setup() {
  const ctx = fakeCtx();
  const t = createTask(ctx, {brief: {goal: "g", repo: "/work/app"}, kind: null, requestedExecutor: null, timeoutS: 60});
  const path = join(ctx.home, `pacer-${t.id}-codex`);
  mkdirSync(path, {recursive: true});
  updateTask(ctx, t.id, x => {
    x.state = "done"; x.worktree = path; x.review = {accepted: true, kind: null, note: null, at: 1};
    x.placement = {requested: "new", mode: "new", why: "test"};
    x.result = {status: "done", executor: "codex", model: null, files: "", report: "", backend: "orca", worktree: path};
  });
  const f = fakeRun([
    [["git", "-C", path, "rev-parse"], raw(`${path}\n`)],
    [["orca", "worktree", "show"], envelope({worktree: {id: `repo::${path}`, path, displayName: `pacer-${t.id}-codex`, isMainWorktree: false}})],
    [["orca", "worktree", "rm"], envelope({})],
  ]);
  ctx.run = f.run;
  return {ctx, t: readTask(ctx, t.id)!, path, f};
}

test("Orca's asynchronous removal is reported only once the directory is gone", async () => {
  const x = setup();
  let sleeps = 0;
  const out = await cleanOrcaTask(x.ctx, x.t, {force: true, shared: () => false}, {polls: 5, sleep: async () => {if (++sleeps === 2) rmSync(x.path, {recursive: true});}});
  expect(out).toEqual({removed: true});
  expect(sleeps).toBe(2);
});

test("a removal still in progress after the bounded poll is kept, then settles on a later pass", async () => {
  const x = setup();
  expect(await cleanOrcaTask(x.ctx, x.t, {force: true, shared: () => false}, {polls: 2, sleep: async () => {}}))
    .toEqual({kept: "Orca is still removing the worktree; run pacer clean again"});
  rmSync(x.path, {recursive: true});
  expect(await cleanOrcaTask(x.ctx, x.t, {force: true, shared: () => false})).toEqual({gone: true});
});

test("dry runs and shared worktrees never call orca worktree rm", async () => {
  const x = setup();
  expect(await cleanOrcaTask(x.ctx, x.t, {dryRun: true, force: true, shared: () => false})).toEqual({removed: true});
  expect(await cleanOrcaTask(x.ctx, x.t, {force: true, shared: () => true})).toEqual({kept: "worktree is shared with an active or unreviewed task"});
  expect(x.f.count(["orca", "worktree", "rm"])).toBe(0);
});
