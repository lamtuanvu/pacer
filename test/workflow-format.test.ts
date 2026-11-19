import { expect, test } from "bun:test";
import { parseWorkflow } from "../src/workflow/parse";
import { validateWorkflow, backEdgeIndexes } from "../src/workflow/validate";
import type { WorkflowDef } from "../src/workflow/schema";

const FIXTURE_OK = `
id: t/demo
version: 1
title: Demo
inputs: { brief: string }
steps:
  ask:
    type: agent
    kind: research
    prompt: "Ask around about {{brief}}"
  work:
    type: agent
    kind: feature
    difficulty: standard
    prompt: "Do the work"
    result:
      required: [answer]
  check:
    type: human
    question:
      text: "Proceed?"
      kind: yes_no
  reviews:
    type: fanout
    branches: [one, two]
    each:
      type: agent
      kind: review
      prompt: "Review it"
    join: all
  redo:
    type: agent
    kind: debug
    prompt: "Fix it again"
  done:
    type: end
edges:
  - [redo, redo, { max_loops: 2 }]
  - [ask, work, "result.answer == 'approve'"]
  - [work, check]
  - [check, reviews]
  - [reviews, done, "result.verdict == 'pass'"]
`;

const FIXTURE_BAD = `
id: t/bad
version: 1
steps:
  start:
    type: deploy
  ask:
    type: human
    question:
      text: "Go on?"
      kind: yes_no
edges:
  - [start, nowhere]
  - [start, ask]
  - [ask, start]
`;

const FIXTURE_UNKNOWN = `
id: t/unknown
version: 1
policy: { replan: 1 }
steps:
  a:
    type: agent
    kind: research
    prompt: hi
    colour: blue
edges: []
`;

test("parses the spec-style YAML and normalises edge tuples", () => {
  const { def, errors } = parseWorkflow(FIXTURE_OK);
  expect(errors).toEqual([]);
  expect(def!.id).toBe("t/demo");
  expect(def!.version).toBe(1);
  expect(def!.edges[1]).toEqual({ from: "ask", to: "work", when: "result.answer == 'approve'" });
  expect(def!.edges[0]).toEqual({ from: "redo", to: "redo", maxLoops: 2 });
  expect(def!.entry).toBe("ask");
  expect(def!.steps.reviews).toMatchObject({ type: "fanout", branches: ["one", "two"], join: "all" });
  expect(def!.steps.work).toMatchObject({ type: "agent", result: { required: ["answer"] } });
});

test("parses JSON the same way", () => {
  const json = JSON.stringify({
    id: "t/json", version: 2,
    steps: { only: { type: "end" } },
    edges: [["only", "only", { max_loops: 1 }]],
  });
  const { def, errors } = parseWorkflow(json);
  expect(errors).toEqual([]);
  expect(def!.entry).toBe("only");
  expect(def!.edges[0]).toEqual({ from: "only", to: "only", maxLoops: 1 });
});

test("an explicit entry wins over the first step", () => {
  const { def } = parseWorkflow(`${FIXTURE_OK}\nentry: work\n`);
  expect(def!.entry).toBe("work");
});

test("reports every structural error at once", () => {
  const errs = validateWorkflow(parseWorkflow(FIXTURE_BAD).def!).map(e => e.path + ": " + e.message);
  expect(errs).toEqual(expect.arrayContaining([
    "edges[0].to: unknown step 'nowhere'",
    "edges[2]: back edge needs max_loops",
    "steps: no end step is reachable from 'start'",
    "steps.start.type: step types allowed are agent, human, fanout, end",
  ]));
});

test("a clean definition validates to no errors", () => {
  expect(validateWorkflow(parseWorkflow(FIXTURE_OK).def!)).toEqual([]);
});

test("rejects a when clause that does not parse", () => {
  const base = parseWorkflow(FIXTURE_OK).def!;
  const withEdgeWhen = (when: string): WorkflowDef => ({ ...base, edges: [{ from: "ask", to: "redo", when }, ...base.edges] });
  expect(validateWorkflow(withEdgeWhen("result.x ==")).map(e => e.path)).toContain("edges[0].when");
  expect(validateWorkflow(withEdgeWhen("result.answer == 'approve'"))).toEqual([]);
});

test("unknown top-level and step fields are errors", () => {
  const errs = parseWorkflow(FIXTURE_UNKNOWN).errors;
  expect(errs.map(e => e.path)).toEqual(expect.arrayContaining(["policy", "steps.a.colour"]));
  expect(errs.find(e => e.path === "steps.a.colour")!.message).toContain("unknown field 'colour'");
});

test("invalid YAML reports one error at the empty path", () => {
  const { def, errors } = parseWorkflow("steps: [oops\nid: ]{");
  expect(def).toBeUndefined();
  expect(errors).toHaveLength(1);
  expect(errors[0].path).toBe("");
});

test("a non-mapping document is rejected", () => {
  const { def, errors } = parseWorkflow("- just\n- a\n- list\n");
  expect(def).toBeUndefined();
  expect(errors).toEqual([{ path: "", message: "workflow must be a mapping" }]);
});

const LOOP_BASE = `
id: t/loop
version: 1
steps:
  a:
    type: agent
    kind: research
    prompt: hi
  b:
    type: agent
    kind: research
    prompt: hi
  done:
    type: end
`;

const loopDef = (edges: WorkflowDef["edges"]): WorkflowDef => ({ ...parseWorkflow(LOOP_BASE).def!, edges });

test("a two-node loop only flags the edge that closes it", () => {
  const clean = loopDef([
    { from: "a", to: "b" },
    { from: "b", to: "a", maxLoops: 2 },
    { from: "b", to: "done" },
  ]);
  expect(validateWorkflow(clean)).toEqual([]);
  expect(backEdgeIndexes(clean)).toEqual(new Set([1]));

  const missing = loopDef([
    { from: "a", to: "b" },
    { from: "b", to: "a" },
    { from: "b", to: "done" },
  ]);
  expect(validateWorkflow(missing)).toEqual([{ path: "edges[1]", message: "back edge needs max_loops" }]);
});

test("a self-loop still needs max_loops", () => {
  const clean = loopDef([
    { from: "a", to: "a", maxLoops: 1 },
    { from: "a", to: "done" },
    { from: "b", to: "done" },
  ]);
  expect(validateWorkflow(clean)).toEqual([]);
  expect(backEdgeIndexes(clean)).toEqual(new Set([0]));

  const missing = loopDef([
    { from: "a", to: "a" },
    { from: "a", to: "done" },
    { from: "b", to: "done" },
  ]);
  expect(validateWorkflow(missing)).toEqual([{ path: "edges[0]", message: "back edge needs max_loops" }]);
});
