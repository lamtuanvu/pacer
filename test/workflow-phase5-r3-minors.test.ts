import { expect, test } from "bun:test";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import {
  getRun, insertRun, setRunConflict, updateRun, workflowDatabase,
} from "../src/workflow/store";
import { cleanupRun } from "../src/workflow/cleanup";
import { ensureRunBranch } from "../src/workflow/branch";
import { hasUnresolvedConflictTask } from "../src/workflow/publish";
import { artifactRoute } from "../src/serve/artifact-routes";
import { createTask, updateTask } from "../src/tasks/store";
import { insertStep } from "../src/workflow/store";
import { storeArtifact, runArtifactsDir } from "../src/workflow/artifacts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("M1: cleanupRun clears conflict markers only when delete_branch is true", async () => {
  const ctx = fakeCtx({ run: realRun });
  workflowDatabase(ctx);
  const repo = gitRepo();
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  let live = getRun(ctx, run.id)!;
  updateRun(ctx, live.id, live.rev, { status: "done" });
  live = getRun(ctx, run.id)!;
  setRunConflict(ctx, live.id, {
    taskId: "t_x", branch: "pacer/t_x", resolutionTaskId: "t_res",
  });
  expect(hasUnresolvedConflictTask(ctx, live.id)).toBe(true);

  await cleanupRun(ctx, live.id, { deleteBranch: false, expectRev: getRun(ctx, live.id)!.rev });
  expect(hasUnresolvedConflictTask(ctx, live.id)).toBe(true);
  expect(getRun(ctx, live.id)!.branch).toBeTruthy();

  live = getRun(ctx, live.id)!;
  await cleanupRun(ctx, live.id, { deleteBranch: true, expectRev: live.rev });
  expect(hasUnresolvedConflictTask(ctx, live.id)).toBe(false);
  expect(getRun(ctx, live.id)!.branch).toBeUndefined();
});

test("M9: PDF artifacts are served as attachment", async () => {
  const ctx = fakeCtx();
  workflowDatabase(ctx);
  const repo = tmpDir();
  const run = insertRun(ctx, { workflow: "t/art", version: 1, repo, brief: "b", stepMode: "plain" });
  const task = createTask(ctx, {
    brief: { goal: "a", repo }, kind: "feature", requestedExecutor: null, timeoutS: 60,
  });
  insertStep(ctx, { runId: run.id, stepId: "impl", attempt: 1, taskId: task.id, status: "running" });
  const wt = tmpDir();
  updateTask(ctx, task.id, t => { t.worktree = wt; t.state = "running"; });
  const pdf = join(wt, "doc.pdf");
  writeFileSync(pdf, "%PDF-1.4\n");
  const art = storeArtifact(ctx, task.id, { path: pdf, label: "doc" });
  const res = await artifactRoute(
    new Request(`http://127.0.0.1/v3/runs/${run.id}/artifacts/${art.id}`),
    ctx,
  );
  expect(res).not.toBeNull();
  expect(res!.headers.get("Content-Disposition")).toMatch(/^attachment;/);
});
