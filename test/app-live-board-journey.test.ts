/** Journey playback model: events only from rows, decisions and graph versions; frames walk the recorded order. */
import { expect, test } from "bun:test";
import { layoutLiveBoard } from "../app/src/screens/runs/live-board-layout";
import { buildJourney, frameAt } from "../app/src/screens/runs/journey";
import { journeyDecisions, journeyDefinition, journeyExecutors, journeyInput, journeyRun } from "./app-live-board-fixtures";

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
