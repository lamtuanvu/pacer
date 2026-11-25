/** Live board layout: deterministic, drawn from step rows only, one place per running agent. */
import { expect, test } from "bun:test";
import { layoutLiveBoard, type LayoutInput, type LiveBoardLayout } from "../app/src/screens/runs/live-board-layout";
import { layoutInputFromDetail } from "../app/src/screens/runs/live-board-model";
import {
  fanoutInput, featureDefinition, generatedInput, noDefinitionInput, plainInput, retriedInput, step,
} from "./app-live-board-fixtures";

const place = (l: LiveBoardLayout) => l.nodes.map(n => `${n.id}|${n.kind}|${n.x},${n.y}${n.waitsOnYou ? "|you" : ""}`);

test("layout snapshot: a plain chain draws only the steps that have rows, left to right", () => {
  const l = layoutLiveBoard(plainInput);
  expect(place(l)).toEqual(["brainstorm|desk|0,140", "approve_spec|desk|248,140|you"]);
  expect(l.edges.map(e => e.id)).toEqual(["brainstorm>approve_spec"]);
  expect(l.person).toMatchObject({ at: "approve_spec", x: 380, y: 100 });
  expect([l.width, l.height]).toEqual([424, 216]);
});

test("layout snapshot: a fan-out is one band of parallel lanes, one lane per branch row", () => {
  const l = layoutLiveBoard(fanoutInput);
  expect(place(l)).toEqual([
    "brainstorm|desk|0,244", "approve_spec|desk|248,244",
    "review:architecture|lane|508,168", "review:security|lane|508,252", "review:ux|lane|508,336",
  ]);
  expect(l.bands.map(b => `${b.id}|${b.lanes}|${b.x},${b.y},${b.w}x${b.h}`)).toEqual(["band:review|3|496,140,200x284"]);
  // the edge into the fan-out ends at the band, not at a node the engine does not have
  expect(l.edges.map(e => `${e.id}:${e.from}>${e.to}`)).toEqual(["brainstorm>approve_spec:brainstorm>approve_spec", "approve_spec>review:approve_spec>band:review"]);
  expect(l.person.at).toBeNull();
});

test("layout snapshot: a generated plan is a zone under its generate step, filled only by the child run's steps", () => {
  const l = layoutLiveBoard(generatedInput);
  expect(place(l).sort()).toEqual([
    "approve_spec|desk|248,281", "brainstorm|desk|0,281", "plan|desk|744,140", "review|desk|496,281",
    "zone:plan/api|desk|756,350", "zone:plan/docs|desk|1004,410", "zone:plan/ui|desk|1004,290",
  ]);
  expect(l.zones).toHaveLength(1);
  expect(l.zones[0]).toMatchObject({ id: "zone:plan", stepId: "plan", x: 744, y: 238, w: 448, h: 260, approved: 1, drawn: 3 });
  expect(l.zones[0]!.versions.map(v => `v${v.version}:${v.status}:${v.stepCount}`)).toEqual(["v1:rejected:2", "v2:approved:4"]);
  // the child's own edges are drawn, and its definition-only step ("tests") has no node
  expect(l.edges.map(e => e.id)).toContain("zone:plan/api>ui");
  expect(l.nodes.some(n => n.stepId === "tests")).toBe(false);
});

test("a node exists only for a step row: definition-only steps get no node and no edge", () => {
  for (const input of [plainInput, fanoutInput, generatedInput, noDefinitionInput, retriedInput]) {
    const l = layoutLiveBoard(input);
    const rows = new Set<string>();
    for (const s of input.steps) rows.add(`${s.stepId}\0${s.branch ?? ""}`);
    for (const c of input.children ?? []) for (const s of c.steps) rows.add(`${s.stepId}\0${s.branch ?? ""}`);
    const drawn = new Set(l.nodes.map(n => `${n.stepId}\0${n.branch ?? ""}`));
    expect(drawn).toEqual(rows);
    const ids = new Set([...l.nodes.map(n => n.id), ...l.bands.map(b => b.id)]);
    for (const e of l.edges) { expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true); }
  }
  // the feature definition names open_pr, done and approve_publish; none has a row in the plain fixture
  const names = layoutLiveBoard(plainInput).nodes.map(n => n.stepId);
  for (const missing of ["review", "plan", "approve_publish", "open_pr", "done"]) expect(names).not.toContain(missing);
  expect(Object.keys(featureDefinition.steps)).toContain("open_pr");
});

test("a retried step is one desk at its latest attempt", () => {
  const l = layoutLiveBoard(retriedInput);
  expect(l.nodes.map(n => [n.id, n.attempt, n.status])).toEqual([["build", 2, "running"]]);
});

test("no definition: ordered by start time with no edges (no invented parentage)", () => {
  const l = layoutLiveBoard(noDefinitionInput);
  expect(l.nodes.map(n => n.id)).toEqual(["a", "b", "c"]);
  expect(l.edges).toEqual([]);
});

test("loop edges are not drawn and do not push steps to later columns", () => {
  const withLoop = layoutLiveBoard(plainInput);
  const without = layoutLiveBoard({ ...plainInput, definition: { ...featureDefinition, edges: featureDefinition.edges.filter(e => e.maxLoops === undefined) } });
  expect(place(withLoop)).toEqual(place(without));
});

test("one place per running agent: only running steps with a task, once per task", () => {
  const l = layoutLiveBoard(fanoutInput);
  // t_b is done, so it has no creature
  expect(l.agents.map(a => a.taskId).sort()).toEqual(["t_a", "t_c"]);
  for (const a of l.agents) {
    const node = l.nodes.find(n => n.id === a.nodeId)!;
    expect(node.status).toBe("running");
    expect(a.x).toBeGreaterThanOrEqual(node.x);
    expect(a.x).toBeLessThan(node.x + node.w);
  }
  const twice = layoutLiveBoard({ steps: [step("one", "running", { taskId: "t_same" }), step("two", "running", { taskId: "t_same", startedAt: 910 })], graphs: [] });
  expect(twice.agents).toHaveLength(1);
  const waiting = layoutLiveBoard({ steps: [step("one", "waiting", { taskId: "t_w" })], graphs: [] });
  expect(waiting.agents).toEqual([]);
});

test("the person is the only human figure: beside the step that waits on them, else at home", () => {
  expect(layoutLiveBoard(plainInput).person.at).toBe("approve_spec");
  expect(layoutLiveBoard(fanoutInput).person.at).toBeNull();
  // a waiting step without a matching open question does not summon the person
  expect(layoutLiveBoard({ ...plainInput, openQuestions: [] }).person.at).toBeNull();
});

test("the layout does not depend on the order rows arrive in", () => {
  for (const input of [plainInput, fanoutInput, generatedInput, noDefinitionInput]) {
    const shuffled: LayoutInput = { ...input, steps: [...input.steps].reverse(), graphs: [...input.graphs].reverse(),
      children: input.children?.map(c => ({ ...c, steps: [...c.steps].reverse() })) };
    expect(JSON.stringify(layoutLiveBoard(shuffled))).toBe(JSON.stringify(layoutLiveBoard(input)));
  }
});

test("desks never overlap each other", () => {
  for (const input of [plainInput, fanoutInput, generatedInput, noDefinitionInput]) {
    const { nodes } = layoutLiveBoard(input);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart).toBe(true);
    }
  }
});

test("a zone fills in only from its own child run and only draws what exists", () => {
  // a child that belongs to another step draws nothing in this zone
  const stranger = layoutLiveBoard({ ...generatedInput, children: generatedInput.children!.map(c => ({ ...c, parentStep: "other" })) });
  expect(stranger.zones[0]).toMatchObject({ drawn: 0, approved: 1 });
  // before any version is approved the zone exists (graph versions) but is empty and says so by approved = 0
  const draft = layoutLiveBoard({ ...generatedInput, graphs: [{ stepId: "plan", attempt: 1, version: 1, status: "draft", stepCount: 3 }], children: [] });
  expect(draft.zones[0]).toMatchObject({ approved: 0, drawn: 0 });
  expect(draft.nodes.map(n => n.id)).not.toContain("zone:plan/api");
  // graph versions for a step that has no row draw no zone
  const orphan = layoutLiveBoard({ steps: [step("a", "done")], graphs: [{ stepId: "ghost", attempt: 1, version: 1, status: "approved", stepCount: 2 }] });
  expect(orphan.zones).toEqual([]);
});

test("layoutInputFromDetail reads steps, definition, graphs and children (parentStep) from run.get shapes, and drops malformed rows", () => {
  const input = layoutInputFromDetail({
    steps: [step("a", "done"), { nope: true }, "x"],
    definition: featureDefinition,
    graphs: [{ stepId: "plan", attempt: 1, version: 2, status: "approved", stepCount: 4 }, { bad: 1 }],
    children: { run_child: { run: { id: "run_child", parentStep: "plan", createdAt: 5 }, steps: [step("api", "done", { runId: "run_child" })], definition: undefined, graphs: [] } },
  }, [{ stepId: "a" }]);
  expect(input.steps.map(s => s.stepId)).toEqual(["a"]);
  expect(input.graphs).toEqual([{ stepId: "plan", attempt: 1, version: 2, status: "approved", stepCount: 4 }]);
  expect(input.children).toEqual([{ runId: "run_child", parentStep: "plan", createdAt: 5, steps: [step("api", "done", { runId: "run_child" })] }]);
  expect(input.definition?.edges.length).toBe(featureDefinition.edges.length);
});
