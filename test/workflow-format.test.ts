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
    "steps.start.type: step types allowed are agent, human, fanout, choose_workflow, generate, end",
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
  // policy is a known top-level key; unknown keys inside it (here: replan) are errors.
  expect(errs.map(e => e.path)).toEqual(expect.arrayContaining(["policy.replan", "steps.a.colour"]));
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

// Phase 2 Task 2: orchestrator role, human decisions, choose_workflow, policy.budget.

test("interactive without the orchestrator role is an error", () => {
  const src = `
id: t/role
version: 1
steps:
  ask:
    type: agent
    kind: research
    interactive: true
    prompt: hi
  done: { type: end }
edges: [[ask, done]]
`;
  const errs = parseWorkflow(src).errors;
  expect(errs.some(e => e.path.includes("interactive") || e.message.includes("interactive"))).toBe(true);
});

test("an orchestrator step may omit kind and set interactive", () => {
  const src = `
id: t/orch
version: 1
steps:
  plan:
    type: agent
    role: orchestrator
    interactive: true
    prompt: Plan it
  done: { type: end }
edges: [[plan, done]]
`;
  const { def, errors } = parseWorkflow(src);
  expect(errors).toEqual([]);
  expect(def!.steps.plan).toMatchObject({ type: "agent", role: "orchestrator", interactive: true, prompt: "Plan it" });
  expect(validateWorkflow(def!)).toEqual([]);
});

test("choose_workflow must have exactly one outgoing edge", () => {
  const one = parseWorkflow(`
id: t/choose
version: 1
steps:
  pick: { type: choose_workflow, from: [a/one, a/two] }
  done: { type: end }
edges: [[pick, done]]
`).def!;
  expect(validateWorkflow(one)).toEqual([]);

  const none = parseWorkflow(`
id: t/choose0
version: 1
steps:
  pick: { type: choose_workflow }
  done: { type: end }
edges: [[done, done]]
`).def!;
  expect(validateWorkflow(none).map(e => e.path)).toEqual(expect.arrayContaining(["steps.pick"]));

  const many = parseWorkflow(`
id: t/choose2
version: 1
steps:
  pick: { type: choose_workflow }
  a: { type: end }
  b: { type: end }
edges: [[pick, a], [pick, b]]
`).def!;
  expect(validateWorkflow(many).some(e => e.path === "steps.pick" && e.message.includes("exactly one"))).toBe(true);
});

test("human decision defaults to must", () => {
  const { def, errors } = parseWorkflow(`
id: t/human
version: 1
steps:
  ask:
    type: human
    question: { text: "Go?", kind: yes_no }
  done: { type: end }
edges: [[ask, done]]
`);
  expect(errors).toEqual([]);
  expect(def!.steps.ask).toMatchObject({ type: "human", decision: "must" });
});

test("unknown policy keys are errors; budget keys are accepted", () => {
  const bad = parseWorkflow(`
id: t/pol
version: 1
policy: { budget: { orchestrator_turns: 10 }, colour: red }
steps:
  done: { type: end }
edges: []
`);
  expect(bad.errors.map(e => e.path)).toEqual(expect.arrayContaining(["policy.colour"]));

  const ok = parseWorkflow(`
id: t/pol2
version: 1
policy: { budget: { orchestrator_turns: 60, message_turns: 20 } }
steps:
  done: { type: end }
edges: []
`);
  expect(ok.errors).toEqual([]);
  expect(ok.def!.policy).toEqual({ budget: { orchestrator_turns: 60, message_turns: 20 } });
});

test("Phase 1 fixtures still parse unchanged", () => {
  const { def, errors } = parseWorkflow(FIXTURE_OK);
  expect(errors).toEqual([]);
  expect(validateWorkflow(def!)).toEqual([]);
  expect(def!.steps.check).toMatchObject({ type: "human", decision: "must" });
});
