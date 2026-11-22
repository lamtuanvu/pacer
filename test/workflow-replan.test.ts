import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { addDefinition, getRun, listGraphs, stepsOfRun, updateRun } from "../src/workflow/store";
import { submitGraph } from "../src/workflow/generate";
import {
  answerGenerateApproval, onTaskSettled, recordStepResult, startRun, type EngineDeps,
} from "../src/workflow/engine";
import {
  graphDiff, noteChildStepFailureForReplan, replanMode, validateReplanKeepFinished,
} from "../src/workflow/replan";
import { checkWorkflowShape, type GenerateLimits, type WorkflowDef } from "../src/workflow/schema";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";

const limits: GenerateLimits = {
  step_types: ["agent", "human", "fanout"],
  max_steps: 8,
  kinds: ["feature", "tests", "docs", "research"],
};

function plan(steps: WorkflowDef["steps"], edges: WorkflowDef["edges"], entry: string): WorkflowDef {
  return { id: "gen/replan", version: 1, steps, edges, entry };
}

const v1 = plan(
  {
    a: { type: "agent", kind: "feature", prompt: "A" },
    b: { type: "agent", kind: "tests", prompt: "B" },
    done: { type: "end" },
  },
  [{ from: "a", to: "b" }, { from: "b", to: "done" }],
  "a",
);

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

test("policy.replan shape is accepted; invalid replan is refused", () => {
  const ok = checkWorkflowShape({
    id: "t/rp",
    version: 1,
    policy: { replan: { auto: 1, then: "ask" } },
    steps: { done: { type: "end" } },
    edges: [],
    entry: "done",
  });
  expect(ok.errors).toEqual([]);
  expect(ok.def!.policy).toEqual({ replan: { auto: 1, then: "ask" } });

  const ask = checkWorkflowShape({
    id: "t/rp2",
    version: 1,
    policy: { replan: "ask" },
    steps: { done: { type: "end" } },
    edges: [],
    entry: "done",
  });
  expect(ask.errors).toEqual([]);
  expect(ask.def!.policy).toEqual({ replan: "ask" });

  const bad = checkWorkflowShape({
    id: "t/rp3",
    version: 1,
    policy: { replan: 1 },
    steps: { done: { type: "end" } },
    edges: [],
    entry: "done",
  });
  expect(bad.errors.some(e => e.path.startsWith("policy.replan"))).toBe(true);
});

test("finished steps must be kept unchanged; changing a finished step is refused", () => {
  const finished = new Set(["a"]);
  const nextOk = plan(
    {
      a: { type: "agent", kind: "feature", prompt: "A" },
      b2: { type: "agent", kind: "tests", prompt: "B2" },
      done: { type: "end" },
    },
    [{ from: "a", to: "b2" }, { from: "b2", to: "done" }],
    "a",
  );
  expect(validateReplanKeepFinished(v1, nextOk, finished)).toEqual([]);

  const nextBad = plan(
    {
      a: { type: "agent", kind: "feature", prompt: "A changed" },
      b: { type: "agent", kind: "tests", prompt: "B" },
      done: { type: "end" },
    },
    [{ from: "a", to: "b" }, { from: "b", to: "done" }],
    "a",
  );
  const errs = validateReplanKeepFinished(v1, nextBad, finished);
  expect(errs.some(e => e.path === "steps.a" && /finished|unchanged|kept/i.test(e.message))).toBe(true);
});

test("graphDiff lists added, removed and changed steps", () => {
  const next = plan(
    {
      a: { type: "agent", kind: "feature", prompt: "A" },
      c: { type: "agent", kind: "docs", prompt: "C" },
      done: { type: "end" },
    },
    [{ from: "a", to: "c" }, { from: "c", to: "done" }],
    "a",
  );
  const diff = graphDiff(v1, next);
  expect(diff.added).toEqual(expect.arrayContaining(["c"]));
  expect(diff.removed).toEqual(expect.arrayContaining(["b"]));
  expect(diff.changed).toEqual([]);
});

test("first failure re-plans automatically with auto:1; the second asks", async () => {
  const ctx = fakeCtx();
  const parent: WorkflowDef = {
    id: "t/replan-parent",
    version: 1,
    policy: { replan: { auto: 1, then: "ask" } },
    steps: {
      plan: {
        type: "generate",
        prompt: "P",
        limits,
        approval: "must",
      },
      done: { type: "end" },
    },
    edges: [{ from: "plan", to: "done" }],
    entry: "plan",
  };
  addDefinition(ctx, parent, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: parent.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: v1 }, deps);
  await answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
  }, deps);
  const planStep = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  const childId = (planStep.result as { childRunId: string }).childRunId;

  const first = noteChildStepFailureForReplan(ctx, childId, "b");
  expect(first).toMatchObject({ mode: "auto", autosUsed: 1, maxAuto: 1 });
  expect(replanMode(ctx, run.id, "plan")).toBe("auto");

  const second = noteChildStepFailureForReplan(ctx, childId, "b");
  expect(second).toMatchObject({ mode: "ask", autosUsed: 1, maxAuto: 1 });
  expect(replanMode(ctx, run.id, "plan")).toBe("ask");
});

test("ask policy always asks; summary carries the diff", async () => {
  const ctx = fakeCtx();
  const parent: WorkflowDef = {
    id: "t/replan-ask",
    version: 1,
    policy: { replan: "ask" },
    steps: {
      plan: { type: "generate", prompt: "P", limits, approval: "must" },
      done: { type: "end" },
    },
    edges: [{ from: "plan", to: "done" }],
    entry: "plan",
  };
  addDefinition(ctx, parent, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: parent.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: v1 }, deps);
  await answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
  }, deps);
  const childId = (stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.result as { childRunId: string }).childRunId;
  const noted = noteChildStepFailureForReplan(ctx, childId, "a");
  expect(noted?.mode).toBe("ask");
  expect(noted?.summary).toMatchObject({
    failedStep: "a",
    added: expect.any(Array),
    removed: expect.any(Array),
    changed: expect.any(Array),
  });
});

test("submitGraph replan refuses changing a finished step id", async () => {
  const ctx = fakeCtx();
  const parent: WorkflowDef = {
    id: "t/replan-submit",
    version: 1,
    policy: { replan: { auto: 2, then: "ask" } },
    steps: {
      plan: { type: "generate", prompt: "P", limits, approval: "must" },
      done: { type: "end" },
    },
    edges: [{ from: "plan", to: "done" }],
    entry: "plan",
  };
  addDefinition(ctx, parent, "source");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: parent.id, repo: tmpDir(), brief: "B" }, undefined, deps);
  await submitGraph(ctx, { runId: run.id, stepId: "plan", source: v1 }, deps);
  await answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
  }, deps);
  const planRow = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  const childId = (planRow.result as { childRunId: string }).childRunId;
  // Mark step a done on the child so it is "finished".
  const childSteps = stepsOfRun(ctx, childId);
  const aRow = childSteps.find(s => s.stepId === "a");
  if (aRow?.taskId) {
    recordStepResult(ctx, aRow.taskId, { ok: true });
    updateTask(ctx, aRow.taskId, t => { t.state = "done"; });
    await onTaskSettled(ctx, aRow.taskId, undefined, deps);
  }
  // Stop the child so parent stays waiting for replan (simulate failure path clearing child).
  noteChildStepFailureForReplan(ctx, childId, "b");
  // Clear childRunId so a new graph can be submitted (replan resubmit).
  const { updateStep } = await import("../src/workflow/store");
  const fresh = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  updateStep(ctx, { runId: run.id, stepId: "plan", attempt: fresh.attempt }, {
    result: {
      ...(fresh.result as object),
      childRunId: undefined,
      pendingApproval: undefined,
      replanFinished: ["a"],
    },
  });

  const changedFinished: WorkflowDef = {
    ...v1,
    steps: {
      ...v1.steps,
      a: { type: "agent", kind: "feature", prompt: "CHANGED" },
    },
  };
  const refused = await submitGraph(ctx, { runId: run.id, stepId: "plan", source: changedFinished }, deps);
  expect(refused.ok).toBe(false);
  expect(refused.errors.some(e => /finished|unchanged|kept/i.test(e.message))).toBe(true);
});

void updateRun;
void listGraphs;
