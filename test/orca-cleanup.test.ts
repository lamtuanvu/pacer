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

test("cleaning a group lane's worktree also removes the group parent once no lane is left under it", async () => {
  const x = setup();
  const {loadOrcaState, updateOrcaState} = await import("../src/exec/orca/state");
  updateTask(x.ctx, x.t.id, t => { t.group = "g1"; });
  updateOrcaState(x.ctx, s => { s.groups["repo:g1"] = {selector: "path:/work/pacer-group-g1"}; });
  const f = fakeRun([
    [["git", "-C", x.path, "rev-parse"], raw(`${x.path}\n`)],
    [["git", "-C", "/work/pacer-group-g1", "status"], raw("")],
    [["orca", "worktree", "show", "--worktree", "path:/work/pacer-group-g1"], envelope({worktree: {id: "repo::/work/pacer-group-g1", path: "/work/pacer-group-g1", displayName: "pacer-group-g1", isMainWorktree: false, childWorktreeIds: []}})],
    [["orca", "worktree", "show"], envelope({worktree: {id: `repo::${x.path}`, path: x.path, displayName: `pacer-${x.t.id}-codex`, isMainWorktree: false}})],
    [["orca", "worktree", "rm"], (a: string[]) => { if (a.includes(`id:repo::${x.path}`)) rmSync(x.path, {recursive: true}); return envelope({}); }],
  ]);
  x.ctx.run = f.run;
  expect(await cleanOrcaTask(x.ctx, readTask(x.ctx, x.t.id)!, {force: true, shared: () => false}, {polls: 1, sleep: async () => {}})).toEqual({removed: true});
  expect(f.calls.filter(a => a[2] === "rm").map(a => a[a.indexOf("--worktree") + 1])).toEqual([`id:repo::${x.path}`, "id:repo::/work/pacer-group-g1"]);
  expect(loadOrcaState(x.ctx).groups).toEqual({});
});

test("a group parent with uncommitted changes stays after its last lane is cleaned", async () => {
  const x = setup();
  const {loadOrcaState, updateOrcaState} = await import("../src/exec/orca/state");
  updateTask(x.ctx, x.t.id, t => { t.group = "g1"; });
  updateOrcaState(x.ctx, s => { s.groups["repo:g1"] = {selector: "path:/work/pacer-group-g1"}; });
  const f = fakeRun([
    [["git", "-C", x.path, "rev-parse"], raw(`${x.path}\n`)],
    [["git", "-C", "/work/pacer-group-g1", "status"], raw(" M notes.md\n")],
    [["orca", "worktree", "show", "--worktree", "path:/work/pacer-group-g1"], envelope({worktree: {id: "repo::/work/pacer-group-g1", path: "/work/pacer-group-g1", displayName: "pacer-group-g1", isMainWorktree: false, childWorktreeIds: []}})],
    [["orca", "worktree", "show"], envelope({worktree: {id: `repo::${x.path}`, path: x.path, displayName: `pacer-${x.t.id}-codex`, isMainWorktree: false}})],
    [["orca", "worktree", "rm"], (a: string[]) => { if (a.includes(`id:repo::${x.path}`)) rmSync(x.path, {recursive: true}); return envelope({}); }],
  ]);
  x.ctx.run = f.run;
  expect(await cleanOrcaTask(x.ctx, readTask(x.ctx, x.t.id)!, {force: true, shared: () => false}, {polls: 1, sleep: async () => {}})).toEqual({removed: true});
  expect(f.calls.filter(a => a[2] === "rm").map(a => a[a.indexOf("--worktree") + 1])).toEqual([`id:repo::${x.path}`]);
  expect(loadOrcaState(x.ctx).groups).toEqual({"repo:g1": {selector: "path:/work/pacer-group-g1"}});
});
