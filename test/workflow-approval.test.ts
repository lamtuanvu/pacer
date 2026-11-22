import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { addDefinition, getRun, listGraphs, stepsOfRun } from "../src/workflow/store";
import { submitGraph } from "../src/workflow/generate";
import {
  answerGenerateApproval, answerHumanStep, failRun, onTaskSettled, recordStepResult,
  startRun, type EngineDeps,
} from "../src/workflow/engine";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";
import type { GenerateLimits, WorkflowDef } from "../src/workflow/schema";
import { CoreError } from "../src/core/errors";

const limits: GenerateLimits = {
  step_types: ["agent", "fanout", "human"],
  max_steps: 5,
  max_depth: 2,
  kinds: ["feature", "tests", "docs", "research"],
  require_after: { "kind in [feature]": "reviewer" },
  require_last: { kind: "tests" },
};

function validPlan(): WorkflowDef {
  return {
    id: "gen/plan",
    version: 1,
    steps: {
      impl: { type: "agent", kind: "feature", prompt: "Implement" },
      review: { type: "agent", role: "reviewer", prompt: "Review" },
      tests: { type: "agent", kind: "tests", prompt: "Test" },
      done: { type: "end" },
    },
    edges: [
      { from: "impl", to: "review" },
      { from: "review", to: "tests" },
      { from: "tests", to: "done" },
    ],
    entry: "impl",
  };
}

function parentDef(approval?: "must" | "auto"): WorkflowDef {
  return {
    id: `t/gen-appr-${approval ?? "none"}`,
    version: 1,
    steps: {
      plan: {
        type: "generate",
        role: "orchestrator",
        prompt: "Write a plan",
        limits,
        retries: 2,
        ...(approval ? { approval } : {}),
      },
      done: { type: "end" },
    },
    edges: [{ from: "plan", to: "done" }],
    entry: "plan",
  };
}

function fakeDeps() {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: EngineDeps["delegate"] = async (ctx, input: DelegateInput) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return readTask(ctx, prior.id) ?? prior;
    const task = createTask(ctx, {
      brief: input.brief,
      kind: input.kind ?? null,
      requestedExecutor: null,
      timeoutS: 600,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.workParent) {
      registerWork(ctx, task.id, input.dispatch ?? {}, input.workParent, input.workGrant);
    }
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  const deps: EngineDeps = {
    delegate,
    stopTask: (ctx, id) => { updateTask(ctx, id, t => { t.state = "stopped"; }); },
  };
  return { deps };
}

test("no child before approval when approval is must", async () => {
  const ctx = fakeCtx();
  const def = parentDef("must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  const submitted = await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  expect(submitted.ok).toBe(true);
  expect(submitted.version).toBe(1);
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect(step.status).toBe("waiting");
  expect((step.result as { childRunId?: string }).childRunId).toBeUndefined();
  expect((step.result as { pendingApproval?: boolean }).pendingApproval).toBe(true);
  expect(listGraphs(ctx, run.id, "plan").find(g => g.version === 1)!.status).toBe("proposed");
});

test("without approval a valid graph starts the child immediately", async () => {
  const ctx = fakeCtx();
  const def = parentDef();
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  const submitted = await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  expect(submitted.ok).toBe(true);
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect((step.result as { childRunId?: string }).childRunId).toBeTruthy();
  expect(listGraphs(ctx, run.id, "plan").find(g => g.version === 1)!.status).toBe("approved");
  const childId = (step.result as { childRunId: string }).childRunId;
  expect(getRun(ctx, childId)?.parentRunId).toBe(run.id);
  expect(getRun(ctx, childId)?.parentStep).toBe("plan");
});

test("revise loops back with the note and counts toward retries", async () => {
  const ctx = fakeCtx();
  const def = parentDef("must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  const after = await answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "revise", note: "add more tests", expectRev: getRun(ctx, run.id)!.rev,
  }, deps);
  expect(after.id).toBe(run.id);
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect(step.status).toBe("waiting");
  expect((step.result as { pendingApproval?: boolean }).pendingApproval).toBeFalsy();
  expect((step.result as { reviseNote?: string }).reviseNote).toBe("add more tests");
  expect((step.result as { reviseCount?: number }).reviseCount).toBe(1);
  expect((step.result as { childRunId?: string }).childRunId).toBeUndefined();
  expect(listGraphs(ctx, run.id, "plan").find(g => g.version === 1)!.status).toBe("rejected");
});

test("must approval cannot be answered by the orchestrator", async () => {
  const ctx = fakeCtx();
  const def = parentDef("must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, {
    workflow: def.id, repo: tmpDir(), brief: "B",
  }, undefined, deps);
  // Turn auto on — must still refuses the orchestrator.
  const { updateRun } = await import("../src/workflow/store");
  updateRun(ctx, run.id, getRun(ctx, run.id)!.rev, { auto: true });
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  const grantCtx = { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: "prg_" + "a".repeat(64) } };
  await expect(answerGenerateApproval(grantCtx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
  }, deps)).rejects.toMatchObject({ code: "not_allowed" });
});

test("approve starts the child; child's end settles the generate step", async () => {
  const ctx = fakeCtx();
  const def = parentDef("must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  await answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
  }, deps);
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  const childId = (step.result as { childRunId: string }).childRunId;
  expect(childId).toBeTruthy();
  expect(listGraphs(ctx, run.id, "plan").find(g => g.version === 1)!.status).toBe("approved");

  // Drive the child to done by settling its entry agent task with a result, then failing remaining? 
  // Simpler: failRun the child → parent generate fails; or complete child's end via fail/done.
  // Complete child: mark its running step done via onTaskSettled after recording result,
  // walking until end. For a short path, fail the child and check parent step failed —
  // plan says child's end settles the step; use done path.
  await failRun(ctx, childId, "forced");
  // failRun ends child as failed → parent generate should fail-settle
  const parentStep = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect(parentStep.status).toBe("failed");
});

test("child done advances the generate step", async () => {
  const ctx = fakeCtx();
  // Tiny generated plan: single end entry so startRun finishes as done immediately.
  const tiny: WorkflowDef = {
    id: "gen/tiny",
    version: 1,
    steps: { done: { type: "end" } },
    edges: [],
    entry: "done",
  };
  const limitsTiny: GenerateLimits = { step_types: ["agent", "human", "fanout"], max_steps: 3 };
  const def: WorkflowDef = {
    id: "t/gen-settle-done",
    version: 1,
    steps: {
      plan: { type: "generate", prompt: "P", limits: limitsTiny, approval: "must" },
      done: { type: "end" },
    },
    edges: [{ from: "plan", to: "done" }],
    entry: "plan",
  };
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: tiny }, deps);
  await answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
  }, deps);
  const parent = getRun(ctx, run.id)!;
  // Child end-entry finishes at start; parent generate should be done and run advanced to done.
  const planStep = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect(planStep.status).toBe("done");
  expect(parent.status === "done" || getRun(ctx, run.id)!.status === "done").toBe(true);
});

test("approval auto may be answered when run.auto is on", async () => {
  const ctx = fakeCtx();
  const def = parentDef("auto");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  const { updateRun } = await import("../src/workflow/store");
  updateRun(ctx, run.id, getRun(ctx, run.id)!.rev, { auto: true });
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  // Simulate run.decide path: env has a grant-like marker but answerGenerateApproval
  // checks canAutoApprove for generate approval:auto.
  const grantCtx = { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: "prg_" + "b".repeat(64) } };
  await answerGenerateApproval(grantCtx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
  }, deps);
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect((step.result as { childRunId?: string }).childRunId).toBeTruthy();
});

// silence unused imports when some paths share helpers
void answerHumanStep;
void onTaskSettled;
void recordStepResult;
void CoreError;
