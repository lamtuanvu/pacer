import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitInfo } from "../src/core/git";
import * as tasks from "../src/core/tasks";
import { createTaskWorktree } from "../src/supervisor/worktree";
import { createTask, updateTask } from "../src/tasks/store";
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

test("clean removes reviewed task worktrees and run dirs, keeps the branch", async () => {
  const { ctx, t, w, repo } = await finished();
  expect(await tasks.clean(ctx)).toEqual({ removed: [t.id], kept: [] });
  expect(existsSync(w.path)).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "runs", t.id))).toBe(false);
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
