import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { registerWork, setWorkDependencies } from "../src/dispatch/work";
import { addDefinition, getRun, listGraphs, stepsOfRun } from "../src/workflow/store";
import { submitGraph } from "../src/workflow/generate";
import {
  answerGenerateApproval, onTaskSettled, recordStepResult, startRun, type EngineDeps,
} from "../src/workflow/engine";
import {
  graphDiff, noteChildStepFailureForReplan, replanMode, validateReplanKeepFinished,
} from "../src/workflow/replan";
import { checkWorkflowShape, type GenerateLimits, type WorkflowDef } from "../src/workflow/schema";
import { needsOrchestrator, openWakeups } from "../src/workflow/wakeups";
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
    if (input.workParent) {
      registerWork(ctx, task.id, input.dispatch ?? {}, input.workParent, input.workGrant);
      if (input.dependencies?.length) {
        setWorkDependencies(ctx, task.id, input.dependencies, readTask(ctx, task.id)!.rev);
      }
    }
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

async function failChildStep(ctx: ReturnType<typeof fakeCtx>, childId: string, stepId: string, deps: EngineDeps) {
  const row = stepsOfRun(ctx, childId).find(s => s.stepId === stepId && s.status === "running");
  expect(row?.taskId).toBeTruthy();
  updateTask(ctx, row!.taskId!, t => { t.state = "failed"; });
  await onTaskSettled(ctx, row!.taskId!, undefined, deps);
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

test("first failure re-plans automatically with auto:1; the second asks (real path)", async () => {
  const ctx = fakeCtx();
  const parent: WorkflowDef = {
    id: "t/replan-parent",
    version: 1,
    policy: { replan: { auto: 1, then: "ask" } },
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

  await failChildStep(ctx, childId, "a", deps);
  expect(replanMode(ctx, run.id, "plan")).toBe("auto");
  const afterFirst = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect((afterFirst.result as { childRunId?: string }).childRunId).toBeUndefined();
  expect(listGraphs(ctx, run.id, "plan").find(g => g.version === 1)!.status).toBe("superseded");
  expect(openWakeups(ctx, run.id).some(w => w.cause === "replan")).toBe(true);
  // Failed child step is handed to replan: no duplicate step_failed recreation.
  expect(needsOrchestrator(ctx).filter(n => n.runId === run.id && n.cause === "step_failed")).toHaveLength(0);

  // Same child failure again does not double-count autos.
  const again = noteChildStepFailureForReplan(ctx, childId, "a");
  expect(again?.opened).toBe(false);
  expect(again?.autosUsed).toBe(1);

  // Resubmit replacement (auto) and approve; second child failure asks.
  const v2 = plan(
    {
      a2: { type: "agent", kind: "feature", prompt: "A2" },
      b: { type: "agent", kind: "tests", prompt: "B" },
      done: { type: "end" },
    },
    [{ from: "a2", to: "b" }, { from: "b", to: "done" }],
    "a2",
  );
  const submitted = await submitGraph(ctx, { runId: run.id, stepId: "plan", source: v2 }, deps);
  expect(submitted.ok).toBe(true);
  expect(submitted.version).toBe(2);
  const pending = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  // auto replan with approval:must still needs approve
  expect((pending.result as { pendingApproval?: boolean }).pendingApproval).toBe(true);
  expect((pending.result as { replanDiff?: { added: string[] } }).replanDiff?.added).toEqual(
    expect.arrayContaining(["a2"]),
  );
  await answerGenerateApproval(ctx, {
    runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
  }, deps);
  const child2 = (stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.result as { childRunId: string }).childRunId;
  await failChildStep(ctx, child2, "a2", deps);
  expect(replanMode(ctx, run.id, "plan")).toBe("ask");
});

test("ask policy clears child and accepts a replacement with diff summary", async () => {
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
  await failChildStep(ctx, childId, "a", deps);
  expect(replanMode(ctx, run.id, "plan")).toBe("ask");
  expect((stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.result as { childRunId?: string }).childRunId)
    .toBeUndefined();

  const next = plan(
    {
      a: { type: "agent", kind: "feature", prompt: "A" },
      c: { type: "agent", kind: "docs", prompt: "C" },
      done: { type: "end" },
    },
    [{ from: "a", to: "c" }, { from: "c", to: "done" }],
    "a",
  );
  const submitted = await submitGraph(ctx, { runId: run.id, stepId: "plan", source: next }, deps);
  expect(submitted.ok).toBe(true);
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect((step.result as { pendingApproval?: boolean }).pendingApproval).toBe(true);
  expect((step.result as { replanDiff?: { added: string[]; removed: string[] } }).replanDiff).toMatchObject({
    added: expect.arrayContaining(["c"]),
    removed: expect.arrayContaining(["b"]),
  });
  expect((step.result as { replanSummary?: string }).replanSummary).toMatch(/Failed step: a/);
});

test("submitGraph replan refuses changing a finished step id (no hand-edited state)", async () => {
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
  const childId = (stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.result as { childRunId: string }).childRunId;
  // Finish step a on the child, then fail step b through the real settlement path.
  const aRow = stepsOfRun(ctx, childId).find(s => s.stepId === "a");
  if (aRow?.taskId) {
    recordStepResult(ctx, aRow.taskId, { ok: true });
    updateTask(ctx, aRow.taskId, t => { t.state = "done"; });
    await onTaskSettled(ctx, aRow.taskId, undefined, deps);
  }
  await failChildStep(ctx, childId, "b", deps);

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

test("needsOrchestrator recreates a lost replan wake", async () => {
  const ctx = fakeCtx();
  const parent: WorkflowDef = {
    id: "t/replan-wake",
    version: 1,
    policy: { replan: { auto: 1, then: "ask" } },
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
  await failChildStep(ctx, childId, "a", deps);
  // Drop the open replan wake.
  const { workflowDatabase } = await import("../src/workflow/store");
  workflowDatabase(ctx).query("UPDATE workflow_wakeups SET done_at = ? WHERE cause = 'replan'",).run(ctx.now);
  const needed = needsOrchestrator(ctx).filter(n => n.runId === run.id && n.cause === "replan");
  expect(needed.length).toBeGreaterThan(0);
});
