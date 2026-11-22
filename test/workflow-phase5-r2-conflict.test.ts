import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import * as tasks from "../src/core/tasks";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { createTaskWorktree } from "../src/supervisor/worktree";
import { gitInfo } from "../src/core/git";
import {
  getRun, insertRun, insertStep, workflowDatabase,
} from "../src/workflow/store";
import {
  ensureRunBranch, integrationWorktree, mergeTaskOnAccept, syncBase,
} from "../src/workflow/branch";
import { hasUnresolvedConflictTask, publishRun } from "../src/workflow/publish";

async function seededRun() {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  return { ctx, repo, run: getRun(ctx, run.id)! };
}

async function makeConflictingTask(
  ctx: ReturnType<typeof fakeCtx>, repo: string, runId: string, file: string, body: string,
) {
  const task = createTask(ctx, {
    brief: { goal: "impl", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId, stepId: `s-${task.id.slice(-6)}`, attempt: 1, taskId: task.id, status: "done" });
  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);
  const run = getRun(ctx, runId)!;
  const wt = await createTaskWorktree(ctx, info, task.id, run.branch!);
  if ("error" in wt) throw new Error(wt.error);
  const baseSha = (await ctx.run(["git", "-C", wt.path, "rev-parse", "HEAD"], 10_000)).stdout.trim();
  await Bun.write(join(wt.path, file), body);
  await ctx.run(["git", "-C", wt.path, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `add ${file}`], 10_000);
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.worktree = wt.path;
    t.baseSha = baseSha;
    t.run = { mode: "new", workdir: wt.path, dir: wt.path, logFile: join(wt.path, "log"), startedAt: ctx.now, executor: "codex", attempt: 1 };
    t.result = { status: "done", executor: "codex", model: null, files: file, report: "", backend: "direct", worktree: wt.path };
  });
  return { task: readTask(ctx, task.id)!, worktree: wt.path, branch: wt.branch };
}

async function divergeRun(ctx: ReturnType<typeof fakeCtx>, run: ReturnType<typeof getRun> & object, file: string, body: string) {
  const live = getRun(ctx, (run as { id: string }).id)!;
  const wt = await integrationWorktree(ctx, live);
  await Bun.write(join(wt, file), body);
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `run ${file}`], 10_000);
}

test("R2-F1: accepting resolution without a branch keeps the conflict marker", async () => {
  const { ctx, repo, run } = await seededRun();
  const { task } = await makeConflictingTask(ctx, repo, run.id, "clash.txt", "from-task\n");
  await divergeRun(ctx, run, "clash.txt", "from-run\n");

  const conflicted = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(conflicted.merge).toBe("conflict");
  const resId = conflicted.resolution_task!;
  expect(readTask(ctx, resId)!.state).toBe("needs_input");

  // Accept resolution with no pacer/<resId> branch and no fix.
  updateTask(ctx, resId, t => {
    t.state = "done";
    t.result = { status: "done", executor: null, model: null, files: "", report: "noop", backend: "direct" };
  });
  const accepted = await tasks.review(ctx, resId, { verdict: "accept" });
  expect(accepted.task.review?.accepted).toBe(true);
  expect(hasUnresolvedConflictTask(ctx, run.id)).toBe(true);
  expect(getRun(ctx, run.id)!.conflict?.some(e => e.resolutionTaskId === resId)).toBe(true);
});

test("R2-F1: unrelated resolution branch does not clear the marker; correct branch does", async () => {
  const { ctx, repo, run } = await seededRun();
  const { task } = await makeConflictingTask(ctx, repo, run.id, "clash.txt", "from-task\n");
  await divergeRun(ctx, run, "clash.txt", "from-run\n");
  const conflicted = await tasks.review(ctx, task.id, { verdict: "accept" });
  const resId = conflicted.resolution_task!;
  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);

  // Unrelated branch: commit that does not contain the conflicting task branch.
  const unrelated = await createTaskWorktree(ctx, info, resId, run.branch!);
  if ("error" in unrelated) throw new Error(unrelated.error);
  await Bun.write(join(unrelated.path, "other.txt"), "side\n");
  await ctx.run(["git", "-C", unrelated.path, "add", "."], 10_000);
  await ctx.run(["git", "-C", unrelated.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "unrelated"], 10_000);
  updateTask(ctx, resId, t => {
    t.state = "done";
    t.worktree = unrelated.path;
    t.result = { status: "done", executor: "codex", model: null, files: "other.txt", report: "", backend: "direct", worktree: unrelated.path };
  });
  await tasks.review(ctx, resId, { verdict: "accept" });
  // Conflicting task branch is still not an ancestor → marker stays.
  expect(hasUnresolvedConflictTask(ctx, run.id)).toBe(true);

  // Fresh resolution that merges the conflicting work in.
  const again = await mergeTaskOnAccept(ctx, task.id);
  expect(again?.merged).toBe(false);
  if (!again || again.merged) throw new Error("expected conflict again");
  const res2 = again.resolution_task;
  const fixWt = await createTaskWorktree(ctx, info, res2, run.branch!);
  if ("error" in fixWt) throw new Error(fixWt.error);
  // Bring conflicting task commits onto the resolution branch, then resolve.
  expect((await ctx.run(["git", "-C", fixWt.path, "merge", "--no-edit", `pacer/${task.id}`], 30_000)).code).not.toBe(0);
  await Bun.write(join(fixWt.path, "clash.txt"), "resolved\n");
  await ctx.run(["git", "-C", fixWt.path, "add", "."], 10_000);
  await ctx.run(["git", "-C", fixWt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "resolve"], 10_000);
  updateTask(ctx, res2, t => {
    t.state = "done";
    t.worktree = fixWt.path;
    t.result = { status: "done", executor: "codex", model: null, files: "clash.txt", report: "fixed", backend: "direct", worktree: fixWt.path };
  });
  await tasks.review(ctx, res2, { verdict: "accept" });
  expect(hasUnresolvedConflictTask(ctx, run.id)).toBe(false);
});

test("R2-F2: re-accept after closed resolution creates a fresh resolution task", async () => {
  const { ctx, repo, run } = await seededRun();
  const { task } = await makeConflictingTask(ctx, repo, run.id, "clash.txt", "from-task\n");
  await divergeRun(ctx, run, "clash.txt", "from-run\n");
  const first = await tasks.review(ctx, task.id, { verdict: "accept" });
  const res1 = first.resolution_task!;
  updateTask(ctx, res1, t => {
    t.state = "done";
    t.result = { status: "done", executor: null, model: null, files: "", report: "noop", backend: "direct" };
  });
  await tasks.review(ctx, res1, { verdict: "accept" });
  expect(readTask(ctx, res1)!.review?.accepted).toBe(true);

  const second = await mergeTaskOnAccept(ctx, task.id);
  expect(second?.merged).toBe(false);
  if (!second || second.merged) throw new Error("expected conflict");
  expect(second.resolution_task).not.toBe(res1);
  expect(getRun(ctx, run.id)!.conflict?.some(e => e.resolutionTaskId === second.resolution_task)).toBe(true);
});

test("R2-F3: a second conflict keeps both entries; clearing one leaves the other", async () => {
  const { ctx, repo, run } = await seededRun();
  const a = await makeConflictingTask(ctx, repo, run.id, "a.txt", "a-task\n");
  await divergeRun(ctx, run, "a.txt", "a-run\n");
  const ca = await tasks.review(ctx, a.task.id, { verdict: "accept" });
  expect(ca.merge).toBe("conflict");

  const b = await makeConflictingTask(ctx, repo, run.id, "b.txt", "b-task\n");
  await divergeRun(ctx, run, "b.txt", "b-run\n");
  const cb = await tasks.review(ctx, b.task.id, { verdict: "accept" });
  expect(cb.merge).toBe("conflict");

  const entries = getRun(ctx, run.id)!.conflict ?? [];
  expect(entries.length).toBe(2);
  expect(entries.map(e => e.taskId).sort()).toEqual([a.task.id, b.task.id].sort());

  // Resolve B only (merge conflicting B branch via resolution).
  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);
  const resB = cb.resolution_task!;
  const wt = await createTaskWorktree(ctx, info, resB, run.branch!);
  if ("error" in wt) throw new Error(wt.error);
  expect((await ctx.run(["git", "-C", wt.path, "merge", "--no-edit", `pacer/${b.task.id}`], 30_000)).code).not.toBe(0);
  await Bun.write(join(wt.path, "b.txt"), "b-ok\n");
  await ctx.run(["git", "-C", wt.path, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix b"], 10_000);
  updateTask(ctx, resB, t => {
    t.state = "done";
    t.worktree = wt.path;
    t.result = { status: "done", executor: "codex", model: null, files: "b.txt", report: "", backend: "direct", worktree: wt.path };
  });
  await tasks.review(ctx, resB, { verdict: "accept" });

  const after = getRun(ctx, run.id)!.conflict ?? [];
  expect(after.some(e => e.taskId === a.task.id)).toBe(true);
  expect(after.some(e => e.taskId === b.task.id)).toBe(false);
  expect(hasUnresolvedConflictTask(ctx, run.id)).toBe(true);
  await expect(publishRun(ctx, run.id, {
    draft: true, title: "t", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({ code: "not_allowed" });
});

test("R2-F4: no-commits-ahead uses task baseSha, not a moved run tip", async () => {
  const { ctx, repo, run } = await seededRun();
  const task = createTask(ctx, {
    brief: { goal: "notes", repo }, kind: "research", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId: run.id, stepId: "notes", attempt: 1, taskId: task.id, status: "done" });
  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);
  // Task branch from the original main (not the run tip), with no commits of its own.
  const mainSha = (await ctx.run(["git", "-C", repo, "rev-parse", "main"], 10_000)).stdout.trim();
  expect((await ctx.run(["git", "-C", repo, "branch", `pacer/${task.id}`, mainSha], 10_000)).code).toBe(0);
  // Move the run branch ahead so run..task would look "ahead" incorrectly.
  await divergeRun(ctx, run, "run-only.txt", "x\n");
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.baseSha = mainSha;
    t.result = { status: "done", executor: "codex", model: null, files: "", report: "ok", backend: "direct" };
  });
  const before = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  const result = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(result.task.review?.accepted).toBe(true);
  const after = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  expect(after).toBe(before);
});

test("R2-F8: dirty current checkout still allows accept when no pacer/<id> branch", async () => {
  const { ctx, repo, run } = await seededRun();
  await Bun.write(join(repo, "dirty.txt"), "uncommitted\n");
  const task = createTask(ctx, {
    brief: { goal: "notes", repo }, kind: "research", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId: run.id, stepId: "notes", attempt: 1, taskId: task.id, status: "done" });
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.placement = { requested: "current", mode: "current", why: "agent: current" };
    t.worktree = repo;
    t.result = {
      status: "done", executor: "codex", model: null, files: "", report: "ok", backend: "direct", worktree: repo,
    };
  });
  const result = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(result.task.review?.accepted).toBe(true);
});

test("R2-F5: sync_base fetches origin/* and merges the advanced tip", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  const bare = join(tmpDir(), "origin.git");
  expect((await ctx.run(["git", "clone", "--bare", "-q", repo, bare], 30_000)).code).toBe(0);
  expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", bare], 10_000)).code).toBe(0);
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const live = getRun(ctx, run.id)!;
  // Force remote-tracking base so sync_base must fetch (setRunBranch is create-once).
  workflowDatabase(ctx).query(
    "UPDATE workflow_runs SET base_ref = ? WHERE id = ?",
  ).run("origin/main", live.id);
  // Advance origin/main with a new commit via a second clone.
  const other = join(tmpDir(), "other");
  expect((await ctx.run(["git", "clone", "-q", bare, other], 30_000)).code).toBe(0);
  await Bun.write(join(other, "from-origin.txt"), "new\n");
  await ctx.run(["git", "-C", other, "add", "."], 10_000);
  await ctx.run(["git", "-C", other, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "origin move"], 10_000);
  expect((await ctx.run(["git", "-C", other, "push", "-q", "origin", "main"], 30_000)).code).toBe(0);

  const synced = await syncBase(ctx, live.id, getRun(ctx, live.id)!.rev);
  expect(synced.ok).toBe(true);
  const show = await ctx.run(["git", "-C", repo, "show", `${live.branch!}:from-origin.txt`], 10_000);
  expect(show.stdout).toBe("new\n");
});

test("R2-F5: unreachable origin fetch fails closed", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", "http://127.0.0.1:1/no-such.git"], 10_000)).code).toBe(0);
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const live = getRun(ctx, run.id)!;
  workflowDatabase(ctx).query(
    "UPDATE workflow_runs SET base_ref = ? WHERE id = ?",
  ).run("origin/main", live.id);
  await expect(syncBase(ctx, live.id, getRun(ctx, live.id)!.rev)).rejects.toMatchObject({
    code: "unavailable",
    message: expect.stringMatching(/fetch failed/i),
  });
});
