/** Fixture runs for the run view tests (plain, fan-out, generated, failed, paused, planner at limit, evidence). */
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { BrowserApi } from "../app/src/data/api";
import { initialState, type StoreState } from "../app/src/data/store";

export const NOW = 1_000_000;
export const WAKE_AT_1800_VN = Date.UTC(2026, 10, 25, 11, 0, 0) / 1000;

export type RunGet = {
  run: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  graphs?: unknown[];
  artifacts?: unknown[];
  decisions?: unknown[];
  definition?: unknown;
  pendingApproval?: unknown;
};
export interface Fixture {
  id: string;
  get: RunGet;
  questions?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  list?: Array<Record<string, unknown>>;
  children?: Record<string, RunGet>;
  tasks?: Array<Record<string, unknown>>;
}

const step = (stepId: string, status: string, over: Record<string, unknown> = {}) => ({
  runId: "run_1", stepId, attempt: 1, status, startedAt: 900, ...over,
});
const baseRun = (over: Record<string, unknown> = {}) => ({
  id: "run_1", workflow: "pacer-dev/feature", version: 2, title: "Ship the board", status: "running", priority: "normal",
  rev: 4, createdAt: 800, updatedAt: 950, orchestratorTaskId: "t_orch", orchestrator: { state: "idle" }, ...over,
});
const featureDefinition = {
  entry: "brainstorm",
  edges: [
    { from: "brainstorm", to: "approve_spec" }, { from: "approve_spec", to: "review" },
    { from: "review", to: "plan" }, { from: "plan", to: "approve_publish" },
    { from: "approve_publish", to: "open_pr" },
  ],
  steps: {
    brainstorm: { type: "agent" }, approve_spec: { type: "human" }, review: { type: "fanout", branches: ["architecture", "ux"] },
    plan: { type: "generate" }, approve_publish: { type: "human" }, open_pr: { type: "agent" }, done: { type: "end" },
  },
};

export const openSpecQuestion = {
  id: "q_spec", runId: "run_1", stepId: "approve_spec", attempt: 1, rev: 3, status: "open", answerer: "person", answerType: "approve_revise",
  text: "Approve the brainstormed spec?", blocks: "step", createdAt: 920,
};

/** Plain run: brainstorm done, spec approval waits on the person. */
export const plain: Fixture = {
  id: "run_1",
  get: {
    run: baseRun({ status: "waiting" }),
    steps: [step("brainstorm", "done", { endedAt: 910, result: { summary: "spec drafted" } }), step("approve_spec", "waiting")],
    definition: featureDefinition,
    decisions: [{ id: "dec_1", runId: "run_1", stepId: "brainstorm", attempt: 1, actor: "orchestrator", kind: "choose", choice: "feature", reason: "The brief asks for a new screen.", at: 905 }],
    artifacts: [{ id: "art_aaaaaaaaaa", label: "Spec draft", name: "spec.md", mime: "text/markdown", size: 40, stepId: "brainstorm", attempt: 1 }],
  },
  questions: [openSpecQuestion],
  messages: [{ id: "m_1", from: "person", to: "task:t_orch", kind: "message", body: "Keep it small.", createdAt: 915 }],
};

/** Fan-out review in progress: two of four reviewers done, findings on one. */
export const fanout: Fixture = {
  id: "run_1",
  get: {
    run: baseRun(),
    steps: [
      step("brainstorm", "done"), step("approve_spec", "done"),
      step("review", "running", { branch: "architecture", taskId: "t_a", result: { verdict: "pass", summary: "Boundaries are fine.", findings: ["Name the store module clearly", { severity: "minor", text: "Add a loading state" }] } }),
      step("review", "done", { branch: "ux", taskId: "t_b", result: { verdict: "revise", summary: "Copy needs work.", findings: [] } }),
      step("review", "running", { branch: "security", taskId: "t_c" }),
    ],
    definition: featureDefinition,
    decisions: [{ id: "dec_2", runId: "run_1", stepId: "review", attempt: 1, actor: "person", kind: "choose", choice: "revise", reason: "Take the UX note.", at: 940 }],
  },
};

/** Fan-out joined with a verdict. */
export const joined: Fixture = {
  id: "run_1",
  get: {
    ...fanout.get,
    steps: [
      ...fanout.get.steps.filter(s => s.stepId !== "review"),
      step("review", "done", { branch: "architecture", result: { verdict: "pass", summary: "ok", findings: [] } }),
      step("review", "done", { branch: "ux", result: { verdict: "pass", summary: "ok", findings: [] } }),
      step("review", "done", { result: { verdict: "pass", summary: "Panel agrees." } }),
    ],
  },
};

/** Generated plan: a child run with a diamond of steps, one stalled executor. */
export const generated: Fixture = {
  id: "run_1",
  get: { run: baseRun(), steps: [step("plan", "running")], definition: featureDefinition },
  list: [
    { id: "run_1", workflow: "pacer-dev/feature", title: "Ship the board", status: "running", priority: "normal", createdAt: 800 },
    { id: "run_child", workflow: "generated", title: "Plan", status: "running", priority: "normal", createdAt: 930, parentRunId: "run_1" },
  ],
  children: {
    run_child: {
      run: baseRun({ id: "run_child", parentRunId: "run_1" }),
      steps: [
        { ...step("api", "done"), runId: "run_child" },
        { ...step("ui", "running", { taskId: "t_ui" }), runId: "run_child" },
        { ...step("docs", "running", { taskId: "t_docs" }), runId: "run_child" },
      ],
      definition: {
        entry: "api",
        edges: [{ from: "api", to: "ui" }, { from: "api", to: "docs" }, { from: "ui", to: "tests" }, { from: "docs", to: "tests" }],
        steps: { api: { type: "agent" }, ui: { type: "agent" }, docs: { type: "agent" }, tests: { type: "agent" } },
      },
    },
  },
  tasks: [{ id: "t_docs", liveness: { stalled: true, reason: "no output", since: NOW - 600 } }, { id: "t_ui", liveness: { stalled: false, reason: "", waitingOn: "the build" , since: NOW - 30 } }],
};

export const failed: Fixture = {
  id: "run_1",
  get: { run: baseRun({ status: "failed", reason: "step failed" }), steps: [step("brainstorm", "done"), step("approve_spec", "failed", { error: "The answer was rejected." })], definition: featureDefinition },
};

export const paused: Fixture = {
  id: "run_1",
  get: { run: baseRun({ pausedReason: "pacing: strict" }), steps: [step("brainstorm", "running")], definition: featureDefinition },
};

export const plannerAtLimit: Fixture = {
  id: "run_1",
  get: { run: baseRun({ orchestrator: { state: "blocked", reason: "planner at limit", next_wake_at: WAKE_AT_1800_VN } }), steps: [step("brainstorm", "running")], definition: featureDefinition },
};

/** Finished with evidence, a run branch, a stub PR, and an open publish approval. */
export const evidence: Fixture = {
  id: "run_1",
  get: {
    run: baseRun({ status: "waiting", branch: "pacer/run-1", baseRef: "main", prUrl: "https://example.test/acme/web/pull/7" }),
    steps: [
      step("tests", "done", { result: {
        summary: "Two surfaces driven, one not.", passed: 1, failed: 1, unverified: 1,
        surfaces: [
          { name: "web runs page", status: "pass", steps: ["open the page", "answer a question"], artifacts: ["art_bbbbbbbbbb"] },
          { name: "desktop app", status: "fail", steps: ["launch"], artifacts: [] },
          { name: "tui", status: "unverified", steps: [], artifacts: ["art_zzzzzzzzzz"] },
        ],
        report: "art_cccccccccc",
      } }),
      step("approve_publish", "waiting"),
    ],
    definition: { entry: "tests", edges: [{ from: "tests", to: "approve_publish" }], steps: { tests: { type: "agent" }, approve_publish: { type: "human" } } },
    artifacts: [
      { id: "art_bbbbbbbbbb", label: "Runs page screenshot", name: "runs.png", mime: "image/png", size: 5000, stepId: "tests" },
      { id: "art_cccccccccc", label: "Evidence report", name: "report.md", mime: "text/markdown", size: 900, stepId: "tests" },
    ],
  },
  questions: [{
    id: "q_pub", runId: "run_1", stepId: "approve_publish", attempt: 1, rev: 1, status: "open", answerer: "person", answerType: "approve_revise",
    text: "Approve publishing this run?", blocks: "step", createdAt: 990,
  }],
};

export interface Calls { ops: Array<{ op: string; params: unknown }> }

export function stateFor(fixture: Fixture, ops: string[], extra: Partial<StoreState> = {}): StoreState {
  const s = initialState();
  return {
    ...s, connected: true,
    features: { readModel: true, ops: new Set(ops) },
    snapshot: { seq: 2, at: NOW, tasks: fixture.tasks ?? [], attention: [], counts: { attention: 0, running: 0, queued: 0, review: 0, failed: 0, setupOpen: 0 }, runs: [] } as unknown as ClientSnapshot,
    ...extra,
  };
}

export const ALL_OPS = ["run.list", "run.get", "run.seen", "question.answer", "question.get", "question.list", "msg.send", "msg.log"];

export function apiFor(fixture: Fixture, calls: Calls, handlers: Partial<Record<string, (params: unknown) => unknown>> = {}): BrowserApi {
  return {
    hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: ALL_OPS, events: [] }),
    snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: {} as never }),
    call: async <T,>(op: string, params?: unknown) => {
      calls.ops.push({ op, params });
      if (handlers[op]) return handlers[op]!(params) as T;
      const id = (params as { id?: string } | undefined)?.id;
      if (op === "run.list") return (fixture.list ?? [fixture.get.run]) as T;
      if (op === "run.get") return (id && fixture.children?.[id] ? fixture.children[id] : fixture.get) as T;
      if (op === "question.list") return (fixture.questions ?? []) as T;
      if (op === "msg.log") return { messages: fixture.messages ?? [] } as T;
      return {} as T;
    },
  };
}
