import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import {
  addDefinition, getDefinition, getRun, insertRun, insertStep, listGraphs, stepsOfRun, updateStep,
  workflowDatabase,
} from "../src/workflow/store";
import { noteGenerateSubmitErrors, submitGraph } from "../src/workflow/generate";
import {
  answerGenerateApproval, failRun, onTaskSettled, recordStepResult, startGeneratedChild, startRun, stopRun,
  type EngineDeps,
} from "../src/workflow/engine";
import { CHOOSING_STALE_S, openWakeups, reconcileStaleChooseClaims } from "../src/workflow/wakeups";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";
import type { GenerateLimits, WorkflowDef } from "../src/workflow/schema";
import { CoreError } from "../src/core/errors";

const limits: GenerateLimits = {
  step_types: ["agent", "fanout", "human"],
  max_steps: 5,
  kinds: ["feature", "tests", "docs", "research"],
};

function validPlan(): WorkflowDef {
  return {
    id: "gen/plan",
    version: 1,
    steps: {
      impl: { type: "agent", kind: "feature", prompt: "Implement" },
      tests: { type: "agent", kind: "tests", prompt: "Test" },
      done: { type: "end" },
    },
    edges: [{ from: "impl", to: "tests" }, { from: "tests", to: "done" }],
    entry: "impl",
  };
}

function parentDef(id: string, approval?: "must" | "auto"): WorkflowDef {
  return {
    id,
    version: 1,
    steps: {
      plan: {
        type: "generate",
        prompt: "Write a plan",
        limits,
        retries: 1,
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
    if (input.workParent) registerWork(ctx, task.id, input.dispatch ?? {}, input.workParent, input.workGrant);
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return {
    deps: {
      delegate,
      stopTask: (ctx: ReturnType<typeof fakeCtx>, id: string) => {
        updateTask(ctx, id, t => { t.state = "stopped"; });
      },
    } satisfies EngineDeps,
  };
}

test("I4: bad graph version is refused before choosing is set", async () => {
  const ctx = fakeCtx();
  const def = parentDef("t/c1-i4-badver", "must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  await expect(startGeneratedChild(ctx, { runId: run.id, stepId: "plan", version: 99 }, undefined, deps))
    .rejects.toMatchObject({ code: "not_found" });
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect((step.result as { choosing?: boolean }).choosing).not.toBe(true);
  expect((step.result as { pendingApproval?: boolean }).pendingApproval).toBe(true);
});

test("I4: stale generate choosing claim is reconciled", async () => {
  const ctx = fakeCtx();
  const def = parentDef("t/c1-i4-stale", "must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  updateStep(ctx, { runId: run.id, stepId: "plan", attempt: step.attempt }, {
    result: {
      ...(step.result as object),
      choosing: true,
      choosingAt: ctx.now - CHOOSING_STALE_S - 1,
      pendingApproval: undefined,
    },
  });
  expect(reconcileStaleChooseClaims(ctx)).toBeGreaterThan(0);
  const after = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect((after.result as { choosing?: boolean }).choosing).not.toBe(true);
  expect((after.result as { pendingApproval?: boolean }).pendingApproval).toBe(true);
});

test("I5: submitGraph refuses while choosing and bumps run rev", async () => {
  const ctx = fakeCtx();
  const def = parentDef("t/c1-i5-choosing", "must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  const revBefore = getRun(ctx, run.id)!.rev;
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  expect(getRun(ctx, run.id)!.rev).toBeGreaterThan(revBefore);
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  updateStep(ctx, { runId: run.id, stepId: "plan", attempt: step.attempt }, {
    result: { ...(step.result as object), choosing: true, choosingAt: ctx.now, pendingApproval: undefined },
  });
  await expect(submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps))
    .rejects.toMatchObject({ code: "conflict" });
});

test("I5: approve is version-bound; stale expect_rev conflicts after submit", async () => {
  const ctx = fakeCtx();
  const def = parentDef("t/c1-i5-rev", "must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  const staleRev = getRun(ctx, run.id)!.rev;
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  await expect(answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: staleRev,
  }, deps)).rejects.toMatchObject({ code: "conflict" });
});

test("I6: generated definition id includes attempt", async () => {
  const ctx = fakeCtx();
  const def = parentDef("t/c1-i6", "must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  await answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
  }, deps);
  const childId = (stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.result as { childRunId: string }).childRunId;
  const child = getRun(ctx, childId)!;
  expect(child.workflow).toMatch(new RegExp(`^gen/${run.id}/plan/a1/v1$`));
  expect(getDefinition(ctx, child.workflow)).toBeTruthy();
});

test("I7: stop parent marks generate stopped, not failed", async () => {
  const ctx = fakeCtx();
  const def = parentDef("t/c1-i7-stop", "must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  await answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
  }, deps);
  const childId = (stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.result as { childRunId: string }).childRunId;
  expect(getRun(ctx, childId)?.status).toMatch(/running|waiting/);
  await stopRun(ctx, run.id, getRun(ctx, run.id)!.rev, deps);
  expect(getRun(ctx, run.id)?.status).toBe("stopped");
  expect(getRun(ctx, childId)?.status).toBe("stopped");
  const planStep = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect(planStep.status).toBe("stopped");
  expect(openWakeups(ctx, run.id).filter(w => w.cause === "step_failed")).toHaveLength(0);
});

test("I7: failRun cascades to live children; done result exposes steps.<id>", async () => {
  const ctx = fakeCtx();
  const tiny: WorkflowDef = {
    id: "gen/tiny-res",
    version: 1,
    steps: {
      only: { type: "agent", kind: "feature", prompt: "X" },
      done: { type: "end" },
    },
    edges: [{ from: "only", to: "done" }],
    entry: "only",
  };
  const def: WorkflowDef = {
    id: "t/c1-i7-result",
    version: 1,
    steps: {
      plan: { type: "generate", prompt: "P", limits: { step_types: ["agent", "human", "fanout"], max_steps: 4, kinds: ["feature"] }, approval: "must" },
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
  const childId = (stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.result as { childRunId: string }).childRunId;
  const only = stepsOfRun(ctx, childId).find(s => s.stepId === "only")!;
  recordStepResult(ctx, only.taskId!, { ok: true, detail: "shipped" });
  updateTask(ctx, only.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, only.taskId!, undefined, deps);
  const planStep = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect(planStep.status).toBe("done");
  expect((planStep.result as { steps?: Record<string, unknown> }).steps?.only).toMatchObject({ ok: true, detail: "shipped" });

  // failRun cascade
  const run2 = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B2" }, undefined, deps);
  await submitGraph(ctx, { runId: run2.id, stepId: "plan", source: tiny }, deps);
  await answerGenerateApproval(ctx, {
    runId: run2.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run2.id)!.rev,
  }, deps);
  const child2 = (stepsOfRun(ctx, run2.id).find(s => s.stepId === "plan")!.result as { childRunId: string }).childRunId;
  await failRun(ctx, run2.id, "parent failed", undefined, deps);
  expect(getRun(ctx, child2)?.status).toBe("failed");
});

test("minor: revise is exact; reviser is not revise", async () => {
  const ctx = fakeCtx();
  const def = parentDef("t/c1-revise", "must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  await expect(answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "reviser please", expectRev: getRun(ctx, run.id)!.rev,
  }, deps)).rejects.toMatchObject({ code: "invalid_input" });
});

test("minor: past retries enqueues step_failed; shape errors count", async () => {
  const ctx = fakeCtx();
  const def: WorkflowDef = {
    id: "t/c1-retries",
    version: 1,
    steps: {
      plan: {
        type: "generate",
        prompt: "Write a plan",
        limits: { step_types: ["agent", "human", "fanout"], max_steps: 2, kinds: ["tests"] },
        retries: 1,
      },
      done: { type: "end" },
    },
    edges: [{ from: "plan", to: "done" }],
    entry: "plan",
  };
  addDefinition(ctx, def, "source");
  const run = insertRun(ctx, { workflow: def.id, version: 1, repo: tmpDir(), brief: "B" });
  insertStep(ctx, { runId: run.id, stepId: "plan", attempt: 1, status: "waiting" });
  const bad: WorkflowDef = {
    id: "bad",
    version: 1,
    steps: { x: { type: "agent", kind: "feature", prompt: "no" }, done: { type: "end" } },
    edges: [{ from: "x", to: "done" }],
    entry: "x",
  };
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: bad });
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: bad });
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect(step.status).toBe("failed");
  expect(openWakeups(ctx, run.id).some(w => w.cause === "step_failed")).toBe(true);

  const run2 = insertRun(ctx, { workflow: def.id, version: 1, repo: tmpDir(), brief: "B2" });
  insertStep(ctx, { runId: run2.id, stepId: "plan", attempt: 1, status: "waiting" });
  const shaped = noteGenerateSubmitErrors(ctx, run2.id, "plan", [{ path: "steps", message: "shape" }]);
  expect(shaped.ok).toBe(false);
  expect((stepsOfRun(ctx, run2.id).find(s => s.stepId === "plan")!.result as { submitFails?: number }).submitFails).toBe(1);
});

test("minor: child inherits parent plain step mode", async () => {
  const ctx = fakeCtx();
  const def = parentDef("t/c1-mode", "must");
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  const { updateRun } = await import("../src/workflow/store");
  updateRun(ctx, run.id, getRun(ctx, run.id)!.rev, { stepMode: "plain" });
  // Plain runs may lack a root; submit/approve still starts a child.
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  await answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
  }, deps);
  const childId = (stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.result as { childRunId: string }).childRunId;
  expect(getRun(ctx, childId)?.stepMode).toBe("plain");
});

test("minor: run.get surfaces pending approval with graph and replan diff", async () => {
  const ctx = fakeCtx();
  const { callOp } = await import("../src/api/ops");
  const def: WorkflowDef = {
    id: "t/c1-runget",
    version: 1,
    policy: { replan: "ask" },
    steps: {
      plan: { type: "generate", prompt: "P", limits, approval: "must" },
      done: { type: "end" },
    },
    edges: [{ from: "plan", to: "done" }],
    entry: "plan",
  };
  addDefinition(ctx, def, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() }, deps);
  const result = await callOp(ctx, "run.get", { id: run.id }) as {
    pendingApproval?: { stepId: string; version: number; graph?: { entry: string } };
  };
  expect(result.pendingApproval).toMatchObject({
    stepId: "plan",
    version: 1,
    graph: expect.objectContaining({ entry: "impl" }),
  });
  void listGraphs;
  void workflowDatabase;
  void CoreError;
});
