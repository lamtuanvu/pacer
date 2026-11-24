import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import { renderDashboard, screenItems } from "../src/dashboard/render";
import { cellWidth } from "../src/dashboard/frame";
import { PLAIN_THEME } from "../src/dashboard/theme";
import { buildRunTree, questionMatchesStep } from "../src/dashboard/screens/run";
import { initialState, reduceKey } from "../src/dashboard/state";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { DashData, RunDetail, RunQuestion } from "../src/dashboard/screens/types";

const snapshot = () => structuredClone(fixture) as unknown as ClientSnapshot;
const now = 1_800_000_000;

const plainDetail = (): RunDetail => ({
  run: {
    id: "r-aaaaaaaaaa",
    workflow: "feature",
    version: 1,
    title: "Ship the frame",
    status: "waiting",
    rev: 4,
    createdAt: now - 600,
    updatedAt: now,
    orchestrator: { state: "blocked", reason: "planner at limit", next_wake_at: now + 3600 },
    orchestratorTaskId: "t-20261123-160000-aaaa",
  },
  steps: [
    { runId: "r-aaaaaaaaaa", stepId: "plan", attempt: 1, status: "done", startedAt: now - 500, endedAt: now - 400, result: { ok: true } },
    { runId: "r-aaaaaaaaaa", stepId: "build", attempt: 1, status: "running", startedAt: now - 100, taskId: "t-20261123-160100-bbbb" },
    { runId: "r-aaaaaaaaaa", stepId: "review", attempt: 1, status: "waiting", startedAt: now - 50 },
  ],
  graphs: [],
  definition: {
    entry: "plan",
    edges: [{ from: "plan", to: "build" }, { from: "build", to: "review" }],
    steps: { plan: { type: "agent" }, build: { type: "agent" }, review: { type: "human" } },
  },
  questions: [{
    id: "q-1", runId: "r-aaaaaaaaaa", stepId: "review", text: "Ship it?", answerType: "yes_no",
    blocks: "step", status: "open", answerer: "person", rev: 1,
  }],
  decisions: [{
    id: "d-1", runId: "r-aaaaaaaaaa", stepId: "plan", attempt: 1, actor: "orchestrator",
    kind: "choose", choice: "build", reason: "ready to implement", at: now - 450,
  }],
});

/** Engine shape: branch rows share the fan-out stepId; join is the branch-less row. */
const fanoutDetail = (): RunDetail => ({
  ...plainDetail(),
  steps: [
    { runId: "r-aaaaaaaaaa", stepId: "plan", attempt: 1, status: "done", startedAt: now - 500, endedAt: now - 400 },
    { runId: "r-aaaaaaaaaa", stepId: "split", attempt: 1, branch: "a", status: "done", startedAt: now - 300, endedAt: now - 200 },
    { runId: "r-aaaaaaaaaa", stepId: "split", attempt: 1, branch: "b", status: "running", startedAt: now - 300 },
    { runId: "r-aaaaaaaaaa", stepId: "after", attempt: 1, status: "waiting", startedAt: now - 100 },
  ],
  definition: {
    entry: "plan",
    edges: [{ from: "plan", to: "split" }, { from: "split", to: "after" }],
    steps: {
      plan: { type: "agent" },
      split: { type: "fanout", branches: ["a", "b"] },
      after: { type: "human" },
    },
  },
  questions: [],
  decisions: [],
});

const twoFanoutsDetail = (): RunDetail => ({
  ...plainDetail(),
  steps: [
    { runId: "r-aaaaaaaaaa", stepId: "first", attempt: 1, branch: "a", status: "done", startedAt: now - 500 },
    { runId: "r-aaaaaaaaaa", stepId: "first", attempt: 1, branch: "b", status: "done", startedAt: now - 500 },
    { runId: "r-aaaaaaaaaa", stepId: "first", attempt: 1, status: "done", startedAt: now - 400 },
    { runId: "r-aaaaaaaaaa", stepId: "second", attempt: 1, branch: "a", status: "running", startedAt: now - 200 },
    { runId: "r-aaaaaaaaaa", stepId: "second", attempt: 1, branch: "b", status: "waiting", startedAt: now - 200 },
  ],
  definition: {
    entry: "first",
    edges: [{ from: "first", to: "second" }],
    steps: {
      first: { type: "fanout", branches: ["a", "b"] },
      second: { type: "fanout", branches: ["a", "b"] },
    },
  },
  questions: [],
  decisions: [],
});

const generatedDetail = (): RunDetail => ({
  ...plainDetail(),
  steps: [
    { runId: "r-aaaaaaaaaa", stepId: "generate", attempt: 1, status: "done", startedAt: now - 500, endedAt: now - 400 },
    { runId: "r-aaaaaaaaaa", stepId: "generate", attempt: 2, status: "done", startedAt: now - 200, endedAt: now - 100 },
    { runId: "r-aaaaaaaaaa", stepId: "impl", attempt: 1, status: "running", startedAt: now - 50 },
  ],
  graphs: [
    { stepId: "generate", attempt: 1, version: 1, status: "approved", stepCount: 2 },
    { stepId: "generate", attempt: 2, version: 3, status: "approved", stepCount: 5 },
  ],
  definition: {
    entry: "generate",
    edges: [{ from: "generate", to: "impl" }],
    steps: { generate: { type: "generate" }, impl: { type: "agent" } },
  },
  questions: [],
  decisions: [],
});

const retriesDetail = (): RunDetail => ({
  ...plainDetail(),
  steps: [
    { runId: "r-aaaaaaaaaa", stepId: "build", attempt: 1, status: "failed", startedAt: now - 500, endedAt: now - 400 },
    { runId: "r-aaaaaaaaaa", stepId: "build", attempt: 2, status: "failed", startedAt: now - 300, endedAt: now - 200 },
    { runId: "r-aaaaaaaaaa", stepId: "build", attempt: 3, status: "running", startedAt: now - 100 },
  ],
  definition: {
    entry: "build",
    edges: [],
    steps: { build: { type: "agent" } },
  },
  questions: [],
  decisions: [],
});

const dataFor = (detail: RunDetail): Partial<DashData> => ({
  details: new Map(),
  settings: {},
  runs: { value: [detail.run] },
  runDetails: new Map([[detail.run.id, { value: detail }]]),
});

const bounded = (text: string, width: number, height: number) => {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  expect(lines).toHaveLength(height);
  for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(width);
};

describe("run tree", () => {
  test("plain, fan-out, generated and retries with explicit parents", () => {
    const reviewQ: RunQuestion = {
      id: "q-1", runId: "r-aaaaaaaaaa", stepId: "review", attempt: 1, text: "?", answerType: "yes_no",
      blocks: "step", status: "open", answerer: "person", rev: 1,
    };
    const plain = buildRunTree(plainDetail(), [reviewQ]);
    expect(plain.map(l => l.label)).toEqual(["plan", "build", "review"]);
    expect(plain.find(l => l.stepId === "review")?.waitsOnYou).toBe(true);

    const fan = buildRunTree(fanoutDetail(), new Set());
    const split = fan.find(l => l.stepId === "split" && !l.branch);
    expect(split?.depth).toBe(0);
    const branchA = fan.find(l => l.branch === "a");
    const branchB = fan.find(l => l.branch === "b");
    expect(branchA?.depth).toBe(1);
    expect(branchB?.depth).toBe(1);
    expect(branchA?.stepId).toBe("split");
    expect(branchB?.stepId).toBe("split");
    // Parent is the fan-out step, not plan/after.
    const splitIdx = fan.findIndex(l => l.stepId === "split" && !l.branch);
    const aIdx = fan.findIndex(l => l.branch === "a");
    const afterIdx = fan.findIndex(l => l.stepId === "after");
    expect(aIdx).toBeGreaterThan(splitIdx);
    expect(afterIdx).toBeGreaterThan(aIdx);

    const two = buildRunTree(twoFanoutsDetail(), new Set());
    const firstA = two.find(l => l.stepId === "first" && l.branch === "a");
    const secondA = two.find(l => l.stepId === "second" && l.branch === "a");
    expect(firstA?.depth).toBe(1);
    expect(secondA?.depth).toBe(1);
    expect(two.filter(l => l.branch === "a")).toHaveLength(2);

    const gen = buildRunTree(generatedDetail(), new Set());
    // Collapsed to attempt 2; graph must key by attempt (v3 under attempt 2, not v1).
    const graph = gen.find(l => l.label.includes("graph"));
    expect(graph?.label).toContain("graph v3");
    expect(graph?.depth).toBe(1);
    expect(graph?.attempt).toBe(2);
    expect(gen.find(l => l.label.includes("graph v1"))).toBeUndefined();

    const retries = buildRunTree(retriesDetail(), new Set());
    expect(retries).toHaveLength(1);
    expect(retries[0]!.attempts).toBe(3);
    expect(retries[0]!.label).toContain("(3)");
    expect(retries[0]!.attempt).toBe(3);
  });

  test("branch questions bind to their own rows; stale attempt is not offered", () => {
    const detail: RunDetail = {
      ...twoFanoutsDetail(),
      steps: [
        { runId: "r-aaaaaaaaaa", stepId: "split", attempt: 1, branch: "x", status: "waiting", startedAt: now - 300 },
        { runId: "r-aaaaaaaaaa", stepId: "split", attempt: 1, branch: "y", status: "waiting", startedAt: now - 300 },
        { runId: "r-aaaaaaaaaa", stepId: "split", attempt: 1, status: "waiting", startedAt: now - 200 },
      ],
      definition: {
        entry: "split",
        edges: [],
        steps: { split: { type: "fanout", branches: ["x", "y"] } },
      },
      questions: [
        {
          id: "qx", runId: "r-aaaaaaaaaa", stepId: "split", attempt: 1, branch: "x",
          text: "Branch x?", answerType: "yes_no", blocks: "branch", status: "open", answerer: "person", rev: 1,
        },
        {
          id: "qy", runId: "r-aaaaaaaaaa", stepId: "split", attempt: 1, branch: "y",
          text: "Branch y?", answerType: "yes_no", blocks: "branch", status: "open", answerer: "person", rev: 1,
        },
      ],
    };
    const tree = buildRunTree(detail, detail.questions!);
    const parent = tree.find(l => l.stepId === "split" && !l.branch)!;
    const bx = tree.find(l => l.branch === "x")!;
    const by = tree.find(l => l.branch === "y")!;
    expect(parent.waitsOnYou).toBe(false);
    expect(bx.waitsOnYou).toBe(true);
    expect(by.waitsOnYou).toBe(true);
    expect(questionMatchesStep(detail.questions![0]!, bx)).toBe(true);
    expect(questionMatchesStep(detail.questions![0]!, by)).toBe(false);
    expect(questionMatchesStep(detail.questions![0]!, parent)).toBe(false);

    const items = screenItems(snapshot(), now, {
      state: { screen: "runs", runView: detail.run.id, selected: { runs: bx.id } },
      data: dataFor(detail),
      ops: ["question.answer", "run.get", "run.list"],
    });
    expect(items.find(i => i.id === bx.id)?.keys.a).toBeDefined();
    expect(items.find(i => i.id === by.id)?.keys.a).toBeDefined();
    expect(items.find(i => i.id === parent.id)?.keys.a).toBeUndefined();

    const stale: RunQuestion = {
      id: "old", runId: "r-aaaaaaaaaa", stepId: "build", attempt: 1,
      text: "Old?", answerType: "text", blocks: "step", status: "open", answerer: "person", rev: 1,
    };
    const retryDetail: RunDetail = {
      ...retriesDetail(),
      questions: [stale],
    };
    const retryTree = buildRunTree(retryDetail, [stale]);
    expect(retryTree[0]!.attempt).toBe(3);
    expect(retryTree[0]!.waitsOnYou).toBe(false);
    expect(questionMatchesStep(stale, retryTree[0]!)).toBe(false);
  });

  test("missing exact definition lists by start time with a note", () => {
    const detail: RunDetail = {
      ...plainDetail(),
      definition: undefined,
      steps: [
        { runId: "r-aaaaaaaaaa", stepId: "late", attempt: 1, status: "running", startedAt: now - 50 },
        { runId: "r-aaaaaaaaaa", stepId: "early", attempt: 1, status: "done", startedAt: now - 500 },
      ],
      questions: [],
    };
    const tree = buildRunTree(detail, []);
    expect(tree.map(l => l.stepId)).toEqual(["early", "late"]);
    const text = renderDashboard(snapshot(), 120, 40, now, {
      theme: PLAIN_THEME,
      state: { screen: "runs", runView: detail.run.id },
      data: dataFor(detail),
      timeZone: "UTC",
    });
    expect(text).toContain("Workflow definition for this version");
  });

  test("a is offered only for human waits and pendingApproval, not fan-out/join", () => {
    const detail = fanoutDetail();
    const items = screenItems(snapshot(), now, {
      state: { screen: "runs", runView: detail.run.id, selected: { runs: "step:after:1:" } },
      data: dataFor(detail),
      ops: ["run.answer", "run.stop", "run.get", "run.list"],
    });
    const after = items.find(i => i.id === "step:after:1:");
    expect(after?.keys.a).toBeDefined();

    const splitItems = screenItems(snapshot(), now, {
      state: { screen: "runs", runView: detail.run.id, selected: { runs: "step:split:1:" } },
      data: dataFor(detail),
      ops: ["run.answer", "run.stop"],
    });
    const split = splitItems.find(i => i.id === "step:split:1:");
    expect(split?.keys.a).toBeUndefined();

    const pending: RunDetail = {
      ...plainDetail(),
      steps: [{ runId: "r-aaaaaaaaaa", stepId: "generate", attempt: 1, status: "waiting", startedAt: now - 50 }],
      definition: { entry: "generate", edges: [], steps: { generate: { type: "generate" } } },
      pendingApproval: { stepId: "generate", attempt: 1, version: 2 },
      questions: [],
      decisions: [],
    };
    const pendingItems = screenItems(snapshot(), now, {
      state: { screen: "runs", runView: pending.run.id, selected: { runs: "step:generate:1:" } },
      data: dataFor(pending),
      ops: ["run.answer"],
    });
    expect(pendingItems.find(i => i.id === "step:generate:1:")?.keys.a).toBeDefined();
    const text = renderDashboard(snapshot(), 120, 40, now, {
      theme: PLAIN_THEME,
      state: { screen: "runs", runView: pending.run.id, selected: { runs: "step:generate:1:" } },
      data: dataFor(pending),
      ops: ["run.answer"],
      timeZone: "UTC",
    });
    expect(text.toLowerCase()).toContain("pending approval");
  });
});

describe("run view screen", () => {
  test("orchestrator block and markers; Enter opens task; Esc returns", () => {
    const detail = plainDetail();
    const text = renderDashboard(snapshot(), 120, 40, now, {
      theme: PLAIN_THEME,
      state: { screen: "runs", runView: detail.run.id, selected: { runs: "step:build:1:" } },
      data: dataFor(detail),
      timeZone: "UTC",
    });
    expect(text).toContain("planner at limit until");
    expect(text).toContain("build");
    expect(text).toContain("review");

    const items = screenItems(snapshot(), now, {
      state: { screen: "runs", runView: detail.run.id, selected: { runs: "step:build:1:" } },
      data: dataFor(detail),
    });
    const build = items.find(i => i.id === "step:build:1:");
    expect(build?.primary?.effect).toEqual({ type: "navigate", screen: "sessions", id: "t-20261123-160100-bbbb" });

    const closed = reduceKey(
      { ...initialState("runs"), runView: detail.run.id, selected: { runs: "step:build:1:" } },
      "escape",
      { items, tabs: ["home", "review", "sessions", "runs", "settings"], page: 10, wide: true, hasDetail: true, repos: [], supports: () => true },
    );
    expect(closed.state.runView).toBeNull();
    expect(closed.state.selected.runs).toBe(`run:${detail.run.id}`);
  });

  test("Esc from narrow detail returns to the tree before closing the run", () => {
    const detail = plainDetail();
    const items = screenItems(snapshot(), now, {
      state: { screen: "runs", runView: detail.run.id, selected: { runs: "step:review:1:" }, focus: "detail" },
      data: dataFor(detail),
    });
    const ctx = {
      items, tabs: ["home", "review", "sessions", "runs", "settings"] as const,
      page: 10, wide: false, hasDetail: true, repos: [], supports: () => true,
    };
    const back = reduceKey(
      { ...initialState("runs"), runView: detail.run.id, focus: "detail", selected: { runs: "step:review:1:" } },
      "escape",
      { ...ctx, tabs: [...ctx.tabs] },
    );
    expect(back.state.runView).toBe(detail.run.id);
    expect(back.state.focus).toBe("list");
    const closed = reduceKey(back.state, "escape", { ...ctx, tabs: [...ctx.tabs] });
    expect(closed.state.runView).toBeNull();
  });

  for (const [width, height] of [[120, 40], [80, 24]] as const) {
    test(`snapshots at ${width}x${height}`, () => {
      const detail = plainDetail();
      const text = renderDashboard(snapshot(), width, height, now, {
        theme: PLAIN_THEME,
        state: { screen: "runs", runView: detail.run.id, selected: { runs: "step:review:1:" } },
        data: dataFor(detail),
        timeZone: "UTC",
        version: "0.0.0-test",
      });
      bounded(text, width, height);
      expect(text).toMatchSnapshot();
    });
  }
});
