/** Journey playback model: events only from rows, decisions and graph versions; frames walk the recorded order. */
import { expect, test } from "bun:test";
import { layoutLiveBoard } from "../app/src/screens/runs/live-board-layout";
import { buildJourney, frameAt, replayOf } from "../app/src/screens/runs/journey";
import type { LayoutInput } from "../app/src/screens/runs/live-board-layout";
import { journeyDecisions, journeyDefinition, journeyExecutors, journeyInput, journeyRun, step } from "./app-live-board-fixtures";

const layout = layoutLiveBoard(journeyInput);
const build = (over: Partial<Parameters<typeof buildJourney>[0]> = {}) => buildJourney({
  run: journeyRun, layout, decisions: journeyDecisions, stepTypes: journeyDefinition.steps, executorOf: id => journeyExecutors[id] ?? "unknown executor", ...over,
});
const journey = build();
const texts = journey.events.map(e => e.text);

test("the journey is the recorded story in order: router choice, plan drafts, executors arriving and leaving, the end", () => {
  expect(texts).toEqual([
    "Run started: Ship the board",
    "route starts",
    "The router chose pacer-dev/feature",
    "route finished · Done",
    "oc-glm joins and takes brainstorm; its mascot is generated",
    "oc-glm leaves brainstorm · Done",
    "approve_spec starts",
    "approve_spec finished · Done",
    "plan starts",
    "The planner drafts plan v1 (2 steps)",
    "You: Asked for a revision (revise) · plan",
    "The planner drafts plan v2 (4 steps)",
    "You: Approved the plan (2) · plan",
    "codex joins and takes api; its mascot is generated",
    "plan finished · Done",
    "codex leaves api · Done",
    "oc-glm arrives at ui",
    "oc-glm leaves ui · Done",
    "Run done",
  ]);
  for (let i = 1; i < journey.events.length; i++) expect(journey.events[i]!.at).toBeGreaterThanOrEqual(journey.events[i - 1]!.at);
  journey.events.forEach((e, i) => expect(e.index).toBe(i));
  expect(journey.finished).toBe(true);
});

test("the router's choice comes from a decision on a choose_workflow step, not from its wording", () => {
  const router = journey.events.find(e => e.kind === "router")!;
  expect(router.detail).toBe("The brief asks for a new screen.");
  // the same kind of decision on a step that is not the router is an ordinary decision
  const plain = build({ stepTypes: { route: { type: "agent" } } });
  expect(plain.events.some(e => e.kind === "router")).toBe(false);
  expect(plain.events.find(e => e.text.includes("pacer-dev/feature"))!.kind).toBe("decision");
});

test("a new executor gets a generated mascot once; a returning one just arrives", () => {
  const joins = journey.events.filter(e => e.newExecutor).map(e => e.executor);
  expect(joins).toEqual(["oc-glm", "codex"]);
  expect(journey.events.find(e => e.text === "oc-glm arrives at ui")!.newExecutor).toBeUndefined();
});

test("plan construction: version 1 when the generate step starts, later versions when the next decision on that step was recorded", () => {
  const plans = journey.events.filter(e => e.kind === "plan");
  expect(plans.map(e => [e.version, e.at])).toEqual([[1, 930], [2, 940]]);
  // graph versions for a step that has no row produce no event
  const noGen = layoutLiveBoard({ ...journeyInput, steps: journeyInput.steps.filter(s => s.stepId !== "plan") });
  expect(buildJourney({ run: journeyRun, layout: noGen, decisions: [], executorOf: () => "x" }).events.some(e => e.kind === "plan")).toBe(false);
});

test("an unfinished run has no finish event and says so", () => {
  const live = build({ run: { ...journeyRun, status: "running" } });
  expect(live.finished).toBe(false);
  expect(live.events.some(e => e.kind === "finish")).toBe(false);
  expect(build({ run: { ...journeyRun, status: "failed" } }).events.at(-1)!.text).toBe("Run failed");
});

test("there is no event without a source: no rows, no decisions, no graph versions means only the start", () => {
  const empty = buildJourney({ run: { createdAt: 900, status: "running", title: "T" }, layout: layoutLiveBoard({ steps: [], graphs: [] }), decisions: undefined, executorOf: () => "x" });
  expect(empty.events.map(e => e.text)).toEqual(["Run started: T"]);
  const nothing = buildJourney({ run: {}, layout: layoutLiveBoard({ steps: [], graphs: [] }), decisions: [], executorOf: () => "x" });
  expect(nothing.events).toEqual([]);
});

test("frames: before the first event the board is empty; desks appear when their step starts and never disappear", () => {
  expect(frameAt(journey, layout, -1).visible.size).toBe(0);
  let seen = new Set<string>();
  for (const e of journey.events) {
    const f = frameAt(journey, layout, e.index);
    for (const id of seen) expect(f.visible.has(id)).toBe(true);
    seen = f.visible;
  }
  expect([...frameAt(journey, layout, journey.events.length - 1).visible].sort()).toEqual(layout.nodes.map(n => n.id).sort());
});

test("frames: a step runs between its start and its end, then shows its final status", () => {
  const idx = (text: string) => journey.events.find(e => e.text === text)!.index;
  expect(frameAt(journey, layout, idx("oc-glm joins and takes brainstorm; its mascot is generated")).status.get("brainstorm")).toBe("running");
  expect(frameAt(journey, layout, idx("oc-glm leaves brainstorm · Done") - 1).status.get("brainstorm")).toBe("running");
  expect(frameAt(journey, layout, idx("oc-glm leaves brainstorm · Done")).status.get("brainstorm")).toBe("done");
});

test("frames: one place per working agent, only between arriving and leaving", () => {
  const idx = (text: string) => journey.events.find(e => e.text === text)!.index;
  expect(frameAt(journey, layout, idx("oc-glm joins and takes brainstorm; its mascot is generated")).working).toEqual([{ nodeId: "brainstorm", taskId: "t_brain", executor: "oc-glm" }]);
  expect(frameAt(journey, layout, idx("oc-glm leaves brainstorm · Done")).working).toEqual([]);
  for (const e of journey.events) {
    const ids = frameAt(journey, layout, e.index).working.map(w => w.taskId);
    expect(new Set(ids).size).toBe(ids.length);
  }
});

test("frames: the plan zone fills in as versions are drafted and approved", () => {
  const line = (text: string) => frameAt(journey, layout, journey.events.find(e => e.text === text)!.index).zones.get("zone:plan");
  expect(line("plan starts")).toMatchObject({ drafted: 0, approved: false, line: "Planning has not produced a version yet" });
  expect(line("The planner drafts plan v1 (2 steps)")).toMatchObject({ drafted: 1, approved: false, line: "v1 proposed · 2 steps" });
  expect(line("The planner drafts plan v2 (4 steps)")).toMatchObject({ drafted: 2, approved: false, line: "v2 proposed · 4 steps · v1 rejected" });
  expect(line("You: Approved the plan (2) · plan")).toMatchObject({ approved: true, line: "v2 approved · 4 steps · 0 started · v1 rejected" });
  expect(line("oc-glm arrives at ui")).toMatchObject({ approved: true, line: "v2 approved · 4 steps · 2 started · v1 rejected" });
  // before the generate step starts there is no zone to draw
  expect(frameAt(journey, layout, 0).zones.size).toBe(0);
});

test("the journey does not depend on the order rows and decisions arrive in", () => {
  const shuffled = layoutLiveBoard({ ...journeyInput, steps: [...journeyInput.steps].reverse(), children: journeyInput.children!.map(c => ({ ...c, steps: [...c.steps].reverse() })) });
  const again = buildJourney({ run: journeyRun, layout: shuffled, decisions: [...journeyDecisions].reverse(), stepTypes: journeyDefinition.steps, executorOf: id => journeyExecutors[id] ?? "unknown executor" });
  expect(again.events.map(e => e.text)).toEqual(texts);
});

/** A generate step replanned once: v1's child failed at 960, v2's child carried `api` over (a done row the engine inserted) and ran `ui2`. */
const replanned: LayoutInput = {
  steps: [step("plan", "done", { startedAt: 910, endedAt: 1010 })],
  definition: { entry: "plan", edges: [], steps: { plan: { type: "generate" } } },
  graphs: [
    { stepId: "plan", attempt: 1, version: 1, status: "superseded", stepCount: 2 },
    { stepId: "plan", attempt: 1, version: 2, status: "approved", stepCount: 2 },
  ],
  children: [
    {
      runId: "kid_2", parentStep: "plan", createdAt: 980, status: "done", updatedAt: 1005, workflow: "gen/run_1/plan/a1/v2",
      steps: [
        step("api", "done", { runId: "kid_2", startedAt: 980, endedAt: 980 }),
        step("ui2", "done", { runId: "kid_2", startedAt: 981, endedAt: 1000, taskId: "t_ui" }),
      ],
      definition: { entry: "api", edges: [{ from: "api", to: "ui2" }], steps: { api: { type: "agent" }, ui2: { type: "agent" } } },
    },
    {
      runId: "kid_1", parentStep: "plan", createdAt: 930, status: "stopped", updatedAt: 979, workflow: "gen/run_1/plan/a1/v1",
      steps: [
        step("api", "done", { runId: "kid_1", startedAt: 931, endedAt: 945, taskId: "t_api" }),
        step("ui", "failed", { runId: "kid_1", startedAt: 946, endedAt: 960, taskId: "t_ui" }),
        step("docs", "running", { runId: "kid_1", startedAt: 947, taskId: "t_brain" }),
      ],
      definition: { entry: "api", edges: [{ from: "api", to: "ui" }], steps: { api: { type: "agent" }, ui: { type: "agent" }, docs: { type: "agent" } } },
    },
  ],
};
const replay = (input: LayoutInput, decisions: unknown[]) => {
  const r = replayOf(input);
  const board = layoutLiveBoard(r.layoutInput);
  return { board, journey: buildJourney({ run: { createdAt: 900, updatedAt: 1020, status: "done" }, layout: board, rows: r.rows, plans: r.plans, carried: r.carried, decisions, executorOf: id => id }) };
};
const approvals = [
  { id: "a1", stepId: "plan", attempt: 1, actor: "person", kind: "approve_graph", choice: "1", reason: "", at: 928 },
  { id: "a2", stepId: "plan", attempt: 1, actor: "person", kind: "approve_graph", choice: "2", reason: "", at: 978 },
];

test("a replanned step replays both child runs in time order, with carried-over steps once", () => {
  const { board, journey } = replay(replanned, approvals);
  expect(journey.events.map(e => e.text)).toEqual([
    "Run started", "plan starts", "The planner drafts plan v1 (2 steps)", "You: Approved the plan (1) · plan",
    "t_api joins and takes api (plan v1); its mascot is generated", "t_api leaves api (plan v1) · Done",
    "t_ui joins and takes ui (plan v1); its mascot is generated", "t_brain joins and takes docs (plan v1); its mascot is generated",
    "t_ui leaves ui (plan v1) · Failed", "The planner drafts plan v2 (2 steps)", "You: Approved the plan (2) · plan",
    "t_brain leaves docs (plan v1) · Stopped", "t_ui arrives at ui2 (plan v2)", "t_ui leaves ui2 (plan v2) · Done", "plan finished · Done", "Run done",
  ]);
  expect(board.nodes.map(n => n.stepId).sort()).toEqual(["api", "docs", "plan", "ui", "ui2"]);
  const line = (text: string) => frameAt(journey, board, journey.events.findIndex(e => e.text === text)).zones.get("zone:plan")!.line;
  // v1's approval does not approve v2
  expect(line("The planner drafts plan v1 (2 steps)")).toContain("v1 proposed");
  expect(line("You: Approved the plan (1) · plan")).toContain("v1 approved");
  expect(line("The planner drafts plan v2 (2 steps)")).toContain("v2 proposed");
  expect(line("You: Approved the plan (2) · plan")).toContain("v2 approved · 2 steps · 1 started · v1 replaced");
  expect(line("t_ui arrives at ui2 (plan v2)")).toContain("2 started");
});

test("without a recorded approval a version is approved when its child run starts", () => {
  const { board, journey } = replay(replanned, []);
  const texts = journey.events.map(e => e.text);
  expect(texts.indexOf("The planner drafts plan v1 (2 steps)")).toBeLessThan(texts.indexOf("Plan v1 starts"));
  expect(texts.indexOf("t_ui leaves ui (plan v1) · Failed")).toBeLessThan(texts.indexOf("The planner drafts plan v2 (2 steps)"));
  expect(texts.indexOf("The planner drafts plan v2 (2 steps)")).toBeLessThan(texts.indexOf("Plan v2 starts"));
  expect(journey.events.find(e => e.text === "Plan v2 starts")!.at).toBe(980);
  expect(frameAt(journey, board, texts.indexOf("The planner drafts plan v2 (2 steps)")).zones.get("zone:plan")!.line).toContain("v2 proposed");
});

test("an attempt's first plan is drafted when that attempt started, not when the latest one did", () => {
  const input: LayoutInput = {
    steps: [step("plan", "failed", { attempt: 1, startedAt: 905, endedAt: 915 }), step("plan", "done", { attempt: 2, startedAt: 950, endedAt: 990 })],
    graphs: [{ stepId: "plan", attempt: 1, version: 1, status: "rejected", stepCount: 1 }, { stepId: "plan", attempt: 2, version: 1, status: "approved", stepCount: 1 }],
  };
  const { journey } = replay(input, []);
  const plans = journey.events.filter(e => e.kind === "plan");
  expect(plans.map(e => [e.text, e.at])).toEqual([["The planner drafts plan v1 (1 step)", 905], ["The planner drafts plan v1 (attempt 2) (1 step)", 950]]);
});

test("a plan starts before the first agent of its child arrives in the same second", () => {
  const input: LayoutInput = {
    steps: [step("plan", "done", { startedAt: 910, endedAt: 1000 })],
    graphs: [{ stepId: "plan", attempt: 1, version: 1, status: "approved", stepCount: 1 }],
    children: [{ runId: "kid", parentStep: "plan", createdAt: 930, status: "done", workflow: "gen/run_1/plan/a1/v1", steps: [step("api", "done", { runId: "kid", startedAt: 930, endedAt: 950, taskId: "t_api" })] }],
  };
  const { board, journey } = replay(input, []);
  const texts = journey.events.map(e => e.text);
  const starts = texts.indexOf("Plan v1 starts"), arrives = texts.indexOf("t_api joins and takes api; its mascot is generated");
  expect(starts).toBeGreaterThan(texts.indexOf("The planner drafts plan v1 (1 step)"));
  expect(arrives).toBe(starts + 1);
  expect(frameAt(journey, board, arrives).zones.get("zone:plan")!.line).toContain("v1 approved");
});
