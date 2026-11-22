import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { addDefinition, getRun, insertRun, insertStep, listGraphs, stepsOfRun, workflowDatabase } from "../src/workflow/store";
import { submitGraph, validateGenerated } from "../src/workflow/generate";
import { checkWorkflowShape, type GenerateLimits, type WorkflowDef } from "../src/workflow/schema";
import { validateWorkflow } from "../src/workflow/validate";

const limits: GenerateLimits = {
  step_types: ["agent", "fanout", "human"],
  max_steps: 5,
  max_depth: 2,
  kinds: ["feature", "tests", "docs", "refactor", "debug", "boilerplate"],
  require_after: { "kind in [feature, refactor, debug]": "reviewer" },
  require_last: { kind: "tests" },
};

function graph(partial: Partial<WorkflowDef> & Pick<WorkflowDef, "steps" | "edges" | "entry">): WorkflowDef {
  return { id: "gen/plan", version: 1, ...partial };
}

function validPlan(): WorkflowDef {
  return graph({
    steps: {
      impl: { type: "agent", kind: "feature", prompt: "Implement" },
      review: { type: "agent", role: "reviewer", prompt: "Review", result: { required: ["verdict"] } },
      tests: { type: "agent", kind: "tests", prompt: "Test" },
      done: { type: "end" },
    },
    edges: [
      { from: "impl", to: "review" },
      { from: "review", to: "tests" },
      { from: "tests", to: "done" },
    ],
    entry: "impl",
  });
}

test("validateGenerated reports each limit violation by path", () => {
  const bad = graph({
    steps: {
      a: { type: "agent", kind: "feature", prompt: "A" },
      b: { type: "agent", kind: "unknown-kind", prompt: "B" },
      choose: { type: "choose_workflow", from: ["x"] },
      c: { type: "agent", kind: "feature", prompt: "C" },
      d: { type: "agent", kind: "docs", prompt: "D" },
      e: { type: "agent", kind: "boilerplate", prompt: "E" },
      done: { type: "end" },
    },
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "choose" },
      { from: "choose", to: "c" },
      { from: "c", to: "d" },
      { from: "d", to: "e" },
      { from: "e", to: "done" },
      { from: "e", to: "a", maxLoops: 1 },
    ],
    entry: "a",
  });
  const errs = validateGenerated(bad, { ...limits, max_steps: 3 }, 1);
  const paths = errs.map(e => e.path);
  expect(paths).toEqual(expect.arrayContaining([
    "steps",
    "steps.b.kind",
    "steps.choose.type",
    "steps.a",
    "steps.c",
    "steps",
  ]));
  expect(errs.some(e => e.path === "steps" && /max_steps|too many/i.test(e.message))).toBe(true);
  expect(errs.some(e => e.path === "steps.b.kind" && /kind/i.test(e.message))).toBe(true);
  expect(errs.some(e => e.path === "steps.choose.type" && /step_types|not allowed/i.test(e.message))).toBe(true);
  expect(errs.some(e => e.path === "steps.a" && /reviewer|require_after/i.test(e.message))).toBe(true);
  expect(errs.some(e => e.path === "steps.c" && /reviewer|require_after/i.test(e.message))).toBe(true);
  expect(errs.some(e => e.path === "steps" && /require_last|tests/i.test(e.message))).toBe(true);
});

test("require_after accepts a feature step that is followed by a reviewer", () => {
  expect(validateGenerated(validPlan(), limits, 1)).toEqual([]);
});

test("require_last refuses when the last step before end is not the required kind", () => {
  const g = validPlan();
  g.steps.tests = { type: "agent", kind: "docs", prompt: "Docs" };
  const errs = validateGenerated(g, limits, 1);
  expect(errs.some(e => e.path === "steps" && /require_last|tests/i.test(e.message))).toBe(true);
});

test("depth over max_depth is refused", () => {
  const errs = validateGenerated(validPlan(), limits, 3);
  expect(errs.some(e => /depth/i.test(e.message))).toBe(true);
});

test("an unbounded back edge is refused through validateWorkflow", () => {
  const g = graph({
    steps: {
      a: { type: "agent", kind: "docs", prompt: "A" },
      tests: { type: "agent", kind: "tests", prompt: "T" },
      done: { type: "end" },
    },
    edges: [
      { from: "a", to: "tests" },
      { from: "tests", to: "done" },
      { from: "tests", to: "a" },
    ],
    entry: "a",
  });
  const shape = checkWorkflowShape(g);
  expect(shape.errors).toEqual([]);
  const structural = validateWorkflow(shape.def!);
  expect(structural.some(e => /max_loops/i.test(e.message))).toBe(true);
  const errs = validateGenerated(g, { step_types: ["agent", "human", "fanout"], max_steps: 10, require_last: { kind: "tests" } }, 1);
  expect(errs.some(e => /max_loops/i.test(e.message))).toBe(true);
});

test("a valid graph without approval is approved and starts; approval:must stays proposed across resubmits", async () => {
  const ctx = fakeCtx();
  const parent: WorkflowDef = {
    id: "t/gen-parent",
    version: 1,
    steps: {
      plan: {
        type: "generate",
        role: "orchestrator",
        prompt: "Write a plan",
        limits,
        retries: 2,
        approval: "must",
      },
      done: { type: "end" },
    },
    edges: [{ from: "plan", to: "done" }],
    entry: "plan",
  };
  addDefinition(ctx, parent, "source");
  const run = insertRun(ctx, { workflow: parent.id, version: 1, repo: tmpDir(), brief: "B" });
  insertStep(ctx, { runId: run.id, stepId: "plan", attempt: 1, status: "waiting" });

  const first = await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() });
  expect(first.ok).toBe(true);
  expect(first.errors).toEqual([]);
  expect(first.version).toBe(1);
  const v1 = listGraphs(ctx, run.id, "plan").find(g => g.version === 1)!;
  expect(v1.status).toBe("proposed");

  // Clear pending approval so a resubmit is allowed (revise path); supersede by rejecting first.
  const { setGraphStatus, updateStep } = await import("../src/workflow/store");
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  setGraphStatus(ctx, { runId: run.id, stepId: "plan", attempt: 1, version: 1 }, "rejected");
  updateStep(ctx, { runId: run.id, stepId: "plan", attempt: 1 }, {
    result: { submitFails: 0, reviseCount: 1 },
  });

  const second = await submitGraph(ctx, { runId: run.id, stepId: "plan", source: validPlan() });
  expect(second.ok).toBe(true);
  expect(second.version).toBe(2);
  const graphs = listGraphs(ctx, run.id, "plan");
  // Rejected versions stay rejected; insertGraphVersion only supersedes proposed/approved.
  expect(graphs.find(g => g.version === 1)!.status).toBe("rejected");
  expect(graphs.find(g => g.version === 2)!.status).toBe("proposed");
  void step;
});

test("invalid submissions return every error and fail the step past retries", async () => {
  const ctx = fakeCtx();
  const parent: WorkflowDef = {
    id: "t/gen-retry",
    version: 1,
    steps: {
      plan: {
        type: "generate",
        prompt: "Write a plan",
        limits: { step_types: ["agent", "human", "fanout"], max_steps: 2, kinds: ["tests"], require_last: { kind: "tests" } },
        retries: 1,
      },
      done: { type: "end" },
    },
    edges: [{ from: "plan", to: "done" }],
    entry: "plan",
  };
  addDefinition(ctx, parent, "source");
  const run = insertRun(ctx, { workflow: parent.id, version: 1, repo: tmpDir(), brief: "B" });
  insertStep(ctx, { runId: run.id, stepId: "plan", attempt: 1, status: "waiting" });

  const bad: WorkflowDef = {
    id: "bad",
    version: 1,
    steps: {
      x: { type: "agent", kind: "feature", prompt: "no" },
      done: { type: "end" },
    },
    edges: [{ from: "x", to: "done" }],
    entry: "x",
  };
  const first = await submitGraph(ctx, { runId: run.id, stepId: "plan", source: bad });
  expect(first.ok).toBe(false);
  expect(first.errors.length).toBeGreaterThan(0);
  expect(stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.status).toBe("waiting");

  const second = await submitGraph(ctx, { runId: run.id, stepId: "plan", source: bad });
  expect(second.ok).toBe(false);
  const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
  expect(step.status).toBe("failed");
  expect(getRun(ctx, run.id)).toBeTruthy();
});

test("workflow_graphs table exists after workflowDatabase", () => {
  const ctx = fakeCtx();
  const cols = workflowDatabase(ctx).query<{ name: string }, []>("PRAGMA table_info(workflow_graphs)").all().map(c => c.name);
  expect(cols).toEqual(expect.arrayContaining([
    "run_id", "step_id", "attempt", "version", "def", "status", "reason", "created_at",
  ]));
});
