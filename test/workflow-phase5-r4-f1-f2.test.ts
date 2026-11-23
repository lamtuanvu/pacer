import { expect, test } from "bun:test";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import * as tasks from "../src/core/tasks";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import {
  getRun, insertRun, insertStep, stepTaskNeedsRunBranchMerge, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch, mergeTaskOnAccept } from "../src/workflow/branch";
import type { RunFn } from "../src/types";
import { CoreError } from "../src/core/errors";

async function branchedResearchTask(runStub?: RunFn) {
  const base = realRun;
  const ctx = fakeCtx({
    run: runStub ?? base,
  });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, { ...run, repo });
  const live = getRun(ctx, run.id)!;
  const task = createTask(ctx, {
    brief: { goal: "notes", repo }, kind: "research", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId: live.id, stepId: "notes", attempt: 1, taskId: task.id, status: "done" });
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.result = { status: "done", executor: "codex", model: null, files: "", report: "ok", backend: "direct" };
  });
  return { ctx, repo, run: getRun(ctx, live.id)!, task: readTask(ctx, task.id)! };
}

test("F1: rev-parse exit 128 (even English) is unavailable; exit 1 is plain accept; uses --quiet + LC_ALL=C", async () => {
  const probes: { argv: string[]; env?: Record<string, string | undefined> }[] = [];

  // First: exit 128 with English text must NOT be treated as absent after the quiet fix.
  {
    const stub: RunFn = async (argv, timeoutMs, o) => {
      if (argv.includes("rev-parse") && argv.some(a => a.startsWith("refs/heads/pacer/"))) {
        probes.push({ argv: [...argv], env: o?.env });
        return { code: 128, stdout: "", stderr: "fatal: Needed a single revision" };
      }
      return realRun(argv, timeoutMs, o);
    };
    const { ctx, task } = await branchedResearchTask(stub);
    await expect(mergeTaskOnAccept(ctx, task.id)).rejects.toMatchObject({
      code: "unavailable",
    });
  }

  // Second: exit 1 means absent → plain accept (merged:true, no conflict).
  {
    const stub: RunFn = async (argv, timeoutMs, o) => {
      if (argv.includes("rev-parse") && argv.some(a => a.startsWith("refs/heads/pacer/"))) {
        probes.push({ argv: [...argv], env: o?.env });
        return { code: 1, stdout: "", stderr: "revision manquante (nl)" };
      }
      return realRun(argv, timeoutMs, o);
    };
    const { ctx, task } = await branchedResearchTask(stub);
    const merge = await mergeTaskOnAccept(ctx, task.id);
    expect(merge).toEqual({ merged: true });
    const result = await tasks.review(ctx, task.id, { verdict: "accept" });
    expect(result.task.review?.accepted).toBe(true);
  }

  // Only the mergeTaskOnAccept task-branch probe (pacer/t-…) must use --quiet + LC_ALL=C.
  const taskProbes = probes.filter(p =>
    p.argv.some(a => /^refs\/heads\/pacer\/t-/.test(a)),
  );
  expect(taskProbes.length).toBeGreaterThanOrEqual(2);
  for (const p of taskProbes) {
    expect(p.argv).toContain("--quiet");
    expect(p.env?.LC_ALL).toBe("C");
  }
});

test("F2: one malformed conflict JSON row does not break an unrelated plain accept", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  const db = workflowDatabase(ctx);

  // Corrupt conflict on an unrelated run — without json_valid this breaks every probe.
  const bad = insertRun(ctx, { workflow: "t/bad", version: 1, repo, brief: "b", stepMode: "plain" });
  db.query("UPDATE workflow_runs SET conflict = ? WHERE id = ?").run("{not-json", bad.id);

  // Ordinary non-step task accept must not throw from the probe.
  const task = createTask(ctx, {
    brief: { goal: "plain", repo }, kind: "research", requestedExecutor: null, timeoutS: 600,
  });
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.result = { status: "done", executor: "codex", model: null, files: "", report: "ok", backend: "direct" };
  });

  expect(() => stepTaskNeedsRunBranchMerge(ctx, task.id)).not.toThrow();
  expect(stepTaskNeedsRunBranchMerge(ctx, task.id)).toBe(false);

  const result = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(result.task.review?.accepted).toBe(true);
  expect(result.merge).toBeUndefined();

  // Probe that would hit json_extract without json_valid must still throw for a
  // resolution-task id lookup only when the row is valid JSON (malformed rows skipped).
  expect(() => stepTaskNeedsRunBranchMerge(ctx, "t-20990101-000000-dead")).not.toThrow();
  void CoreError;
});
