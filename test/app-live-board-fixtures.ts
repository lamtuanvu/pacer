/** Fixture graphs for the Live board: plain, fan-out, generated, retried, no definition, loop edge. */
import type { RunStepRow } from "../src/dashboard/screens/types";
import type { LayoutDefinition, LayoutInput } from "../app/src/screens/runs/live-board-layout";

export const step = (stepId: string, status: string, over: Partial<RunStepRow> = {}): RunStepRow => ({
  runId: "run_1", stepId, attempt: 1, status, startedAt: 900, ...over,
});

export const featureDefinition: LayoutDefinition = {
  entry: "brainstorm",
  edges: [
    { from: "brainstorm", to: "approve_spec" }, { from: "approve_spec", to: "review" },
    { from: "review", to: "plan" }, { from: "plan", to: "approve_publish" },
    { from: "approve_publish", to: "open_pr" }, { from: "open_pr", to: "done" },
    { from: "review", to: "brainstorm", maxLoops: 2 },
  ],
  steps: {
    brainstorm: { type: "agent" }, approve_spec: { type: "human" }, review: { type: "fanout", branches: ["architecture", "ux", "security"] },
    plan: { type: "generate" }, approve_publish: { type: "human" }, open_pr: { type: "agent" }, done: { type: "end" },
  },
};

/** Brainstorm done, spec approval waits on the person; later steps have no rows yet. */
export const plainInput: LayoutInput = {
  steps: [step("brainstorm", "done", { endedAt: 910, startedAt: 900 }), step("approve_spec", "waiting", { startedAt: 920 })],
  definition: featureDefinition,
  graphs: [],
  openQuestions: [{ stepId: "approve_spec", attempt: 1 }],
};

/** Fan-out review: three lanes (two running with tasks, one done) and no join row yet. */
export const fanoutInput: LayoutInput = {
  steps: [
    step("brainstorm", "done", { startedAt: 900 }), step("approve_spec", "done", { startedAt: 910 }),
    step("review", "running", { branch: "architecture", taskId: "t_a", startedAt: 920 }),
    step("review", "done", { branch: "ux", taskId: "t_b", startedAt: 921 }),
    step("review", "running", { branch: "security", taskId: "t_c", startedAt: 922 }),
  ],
  definition: featureDefinition,
  graphs: [],
};

/** A generated plan: two graph versions (v1 rejected, v2 approved) and a child run with a diamond of steps. */
export const generatedInput: LayoutInput = {
  steps: [step("brainstorm", "done"), step("approve_spec", "done", { startedAt: 910 }), step("review", "done", { startedAt: 920 }), step("plan", "running", { startedAt: 930 })],
  definition: featureDefinition,
  graphs: [
    { stepId: "plan", attempt: 1, version: 1, status: "rejected", stepCount: 2 },
    { stepId: "plan", attempt: 1, version: 2, status: "approved", stepCount: 4 },
  ],
  children: [{
    runId: "run_child", parentStep: "plan", createdAt: 940,
    steps: [
      step("api", "done", { runId: "run_child", startedAt: 940 }),
      step("ui", "running", { runId: "run_child", taskId: "t_ui", startedAt: 941 }),
      step("docs", "running", { runId: "run_child", taskId: "t_docs", startedAt: 942 }),
    ],
    definition: {
      entry: "api",
      edges: [{ from: "api", to: "ui" }, { from: "api", to: "docs" }, { from: "ui", to: "tests" }, { from: "docs", to: "tests" }],
      steps: { api: { type: "agent" }, ui: { type: "agent" }, docs: { type: "agent" }, tests: { type: "agent" } },
    },
  }],
};

/** No stored definition: the board orders by start time and draws no edge. */
export const noDefinitionInput: LayoutInput = {
  steps: [step("b", "running", { startedAt: 20, taskId: "t_b" }), step("a", "done", { startedAt: 10 }), step("c", "pending", { startedAt: 30 })],
  graphs: [],
};

/** Attempt 2 of a step supersedes attempt 1. */
export const retriedInput: LayoutInput = {
  steps: [step("build", "failed", { attempt: 1, startedAt: 10 }), step("build", "running", { attempt: 2, startedAt: 20, taskId: "t_build" })],
  definition: { entry: "build", edges: [], steps: { build: { type: "agent" } } },
  graphs: [],
};

/** A finished run's journey: the router picks a workflow, brainstorm, a plan revised once, then executors arrive and leave. */
export const journeyDefinition: LayoutDefinition = {
  entry: "route",
  edges: [{ from: "route", to: "brainstorm" }, { from: "brainstorm", to: "approve_spec" }, { from: "approve_spec", to: "plan" }],
  steps: { route: { type: "choose_workflow" }, brainstorm: { type: "agent" }, approve_spec: { type: "human" }, plan: { type: "generate" } },
};
export const journeyInput: LayoutInput = {
  steps: [
    step("route", "done", { startedAt: 901, endedAt: 905 }),
    step("brainstorm", "done", { startedAt: 906, endedAt: 920, taskId: "t_brain" }),
    step("approve_spec", "done", { startedAt: 921, endedAt: 929 }),
    step("plan", "done", { startedAt: 930, endedAt: 960 }),
  ],
  definition: journeyDefinition,
  graphs: [
    { stepId: "plan", attempt: 1, version: 1, status: "rejected", stepCount: 2 },
    { stepId: "plan", attempt: 1, version: 2, status: "approved", stepCount: 4 },
  ],
  children: [{
    runId: "run_child", parentStep: "plan", createdAt: 956,
    steps: [
      step("api", "done", { runId: "run_child", startedAt: 957, endedAt: 970, taskId: "t_api" }),
      step("ui", "done", { runId: "run_child", startedAt: 971, endedAt: 990, taskId: "t_ui" }),
    ],
    definition: { entry: "api", edges: [{ from: "api", to: "ui" }], steps: { api: { type: "agent" }, ui: { type: "agent" } } },
  }],
};
export const journeyDecisions = [
  { id: "d1", runId: "run_1", stepId: "route", attempt: 1, actor: "orchestrator", kind: "choose", choice: "pacer-dev/feature", reason: "The brief asks for a new screen.", at: 905 },
  { id: "d2", runId: "run_1", stepId: "plan", attempt: 1, actor: "person", kind: "revise_graph", choice: "revise", reason: "Add a docs step.", at: 940 },
  { id: "d3", runId: "run_1", stepId: "plan", attempt: 1, actor: "person", kind: "approve_graph", choice: "2", reason: "", at: 955 },
];
export const journeyExecutors: Record<string, string> = { t_brain: "oc-glm", t_api: "codex", t_ui: "oc-glm" };
export const journeyRun = { createdAt: 900, updatedAt: 995, status: "done", title: "Ship the board" };
