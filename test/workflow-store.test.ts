import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { taskDatabase } from "../src/tasks/store";
import {
  addDefinition, getDefinition, listDefinitions, getCursor, setCursor, getRun, insertRun, insertStep,
  listRuns, stepByTask, stepsOfRun, updateRun, updateStep, workflowDatabase,
  type NewRun, type RunStatus, type StepRow,
} from "../src/workflow/store";
import type { WorkflowDef } from "../src/workflow/schema";

const defV1: WorkflowDef = {
  id: "t/demo",
  version: 1,
  title: "Demo",
  steps: {
    ask: { type: "agent", kind: "research", prompt: "Ask about it" },
    done: { type: "end" },
  },
  edges: [{ from: "ask", to: "done" }],
  entry: "ask",
};
const srcA = "id: t/demo\nversion: 1\nsteps:\n  ask: { type: agent, kind: research, prompt: Ask about it }\n  done: { type: end }\nedges:\n  - [ask, done]\n";
const srcB = `${srcA}# a different source\n`;

const newRun = (): NewRun => ({ workflow: "t/demo", version: 1, repo: tmpDir(), brief: "Do X", title: "Demo run" });

test("definitions are immutable per version", () => {
  const ctx = fakeCtx();
  expect(addDefinition(ctx, defV1, srcA).created).toBe(true);
  expect(addDefinition(ctx, defV1, srcA).created).toBe(false);
  expect(() => addDefinition(ctx, defV1, srcB)).toThrow(/conflict/);
  expect(getDefinition(ctx, "t/demo")!.version).toBe(1);
});

test("definitions resolve by id@version and list with titles", () => {
  const ctx = fakeCtx();
  addDefinition(ctx, defV1, srcA);
  const defV2: WorkflowDef = { ...defV1, version: 2 };
  addDefinition(ctx, defV2, srcB);
  expect(getDefinition(ctx, "t/demo@1")!.version).toBe(1);
  expect(getDefinition(ctx, "t/demo")!.version).toBe(2);
  expect(getDefinition(ctx, "t/none")).toBeNull();
  expect(getDefinition(ctx, "t/demo@9")).toBeNull();
  const listed = listDefinitions(ctx);
  expect(listed).toHaveLength(2);
  expect(listed[0]).toMatchObject({ id: "t/demo", version: 1, title: "Demo" });
});

test("run updates need the current rev", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  expect(r.status).toBe("running");
  expect(r.rev).toBe(1);
  expect(r.id).toMatch(/^run_[a-z2-7]{10}$/);
  const updated = updateRun(ctx, r.id, r.rev, { status: "waiting" });
  expect(updated.rev).toBe(2);
  expect(updated.status).toBe("waiting");
  expect(() => updateRun(ctx, r.id, r.rev, { status: "done" })).toThrow(/conflict/);
  expect(() => updateRun(ctx, "run_missing0000", 1, { status: "done" })).toThrow(/unknown run/);
  expect(getRun(ctx, r.id)!.status).toBe("waiting");
  expect(getRun(ctx, "run_missing0000")).toBeNull();
});

test("runs record loops and list by status", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  insertRun(ctx, { ...newRun(), workflow: "t/other" });
  updateRun(ctx, r.id, r.rev, { status: "failed", reason: "step ask failed", loops: { "check->ask": 1 } });
  const stored = getRun(ctx, r.id)!;
  expect(stored.loops).toEqual({ "check->ask": 1 });
  expect(stored.reason).toBe("step ask failed");
  const failed = listRuns(ctx, "failed" as RunStatus);
  expect(failed.map(run => run.id)).toEqual([r.id]);
  expect(listRuns(ctx)).toHaveLength(2);
});

test("a task id maps to at most one step", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  const first = insertStep(ctx, { runId: r.id, stepId: "ask", attempt: 1, taskId: "t-1", status: "running" });
  expect(first.status).toBe("running");
  expect(first.startedAt).toBeGreaterThan(0);
  expect(() => insertStep(ctx, { runId: r.id, stepId: "other", attempt: 1, taskId: "t-1", status: "running" })).toThrow();
  insertStep(ctx, { runId: r.id, stepId: "ask", attempt: 2, status: "running" }); // no task id, new attempt
  const steps = stepsOfRun(ctx, r.id);
  expect(steps).toHaveLength(2);
  expect(steps[0].taskId).toBe("t-1");
  expect(steps[1].branch).toBeUndefined();
  expect(stepByTask(ctx, "t-1")!.stepId).toBe("ask");
  expect(stepByTask(ctx, "t-none")).toBeNull();
});

test("branch and attempt make the step key", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  insertStep(ctx, { runId: r.id, stepId: "review", attempt: 1, branch: "alpha", taskId: "t-a", status: "running" });
  insertStep(ctx, { runId: r.id, stepId: "review", attempt: 1, branch: "beta", taskId: "t-b", status: "running" });
  const done = updateStep(ctx, { runId: r.id, stepId: "review", attempt: 1, branch: "alpha" }, { status: "done", result: { verdict: "pass" }, endedAt: ctx.now + 5 });
  expect(done.status).toBe("done");
  expect(done.result).toEqual({ verdict: "pass" });
  expect(done.endedAt).toBe(ctx.now + 5);
  const untouched = stepsOfRun(ctx, r.id).find((s: StepRow) => s.branch === "beta")!;
  expect(untouched.status).toBe("running");
  expect(untouched.result).toBeUndefined();
  expect(() => updateStep(ctx, { runId: r.id, stepId: "review", attempt: 9, branch: "alpha" }, { status: "done" })).toThrow(/unknown step/);
});

test("tables live in the task store", () => {
  const ctx = fakeCtx();
  workflowDatabase(ctx);
  for (const name of ["workflow_defs", "workflow_runs", "workflow_steps", "workflow_cursor"]) {
    expect(taskDatabase(ctx).query("SELECT name FROM sqlite_master WHERE name = ?").get(name)).toBeTruthy();
  }
});

test("the cursor persists and defaults to zero", () => {
  const ctx = fakeCtx();
  expect(getCursor(ctx)).toBe(0);
  setCursor(ctx, 42);
  expect(getCursor(ctx)).toBe(42);
  setCursor(ctx, 43);
  expect(getCursor(ctx)).toBe(43);
});
