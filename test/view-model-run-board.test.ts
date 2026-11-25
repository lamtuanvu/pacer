import { expect, test } from "bun:test";
import type { RunDetail } from "../src/dashboard/screens/types";
import {
  actorLabel, boardAvailability, conversationRail, decisionKindLabel, evidenceStatusLabel, executionWaves, pausedReasonLabel,
  pickSpecArtifact, reviewerPanels, stripSteps, testsAndPr, artifactMetas, type BoardInput,
} from "../src/view-model/run-board";
import { evidence, fanout, generated, plain } from "./app-run-view-fixtures";

const detailOf = (f: { get: Record<string, unknown> }) => ({ graphs: [], ...f.get }) as unknown as RunDetail;

test("stripSteps keeps engine order, collapses retries and marks only open person questions", () => {
  const detail = detailOf(plain);
  const strip = stripSteps(detail, [{ id: "q", text: "?", stepId: "approve_spec", status: "open", answerer: "person" }]);
  expect(strip.map(s => [s.stepId, s.waitsOnYou])).toEqual([["brainstorm", false], ["approve_spec", true]]);
  // an answered question does not mark the step
  expect(stripSteps(detail, [{ id: "q", text: "?", stepId: "approve_spec", status: "answered" }]).some(s => s.waitsOnYou)).toBe(false);
  // a question for the orchestrator is not the person's
  expect(stripSteps(detail, [{ id: "q", text: "?", stepId: "approve_spec", status: "open", answerer: "orchestrator" }]).some(s => s.waitsOnYou)).toBe(false);
});

test("a fan-out chip carries branch progress", () => {
  const strip = stripSteps(detailOf(fanout), []);
  const review = strip.find(s => s.stepId === "review")!;
  expect(review.progress).toEqual({ done: 1, total: 3 });
});

test("reviewerPanels reads lanes, findings and the join from step rows only", () => {
  const panels = reviewerPanels(detailOf(fanout), fanout.get.decisions);
  expect(panels).toHaveLength(1);
  const p = panels[0]!;
  expect(p.lanes.map(l => l.branch)).toEqual(["architecture", "security", "ux"]);
  expect(p.lanes[0]!.findings).toEqual(["Name the store module clearly", "minor: Add a loading state"]);
  expect(p.join).toBeUndefined();
  expect(p.status).toBe("running");
  expect(p.decisions.map(d => d.choice)).toEqual(["revise"]);
  // a plain run has no panel
  expect(reviewerPanels(detailOf(plain), [])).toEqual([]);
});

test("executionWaves levels the generated child by its edges and ignores back edges", () => {
  const input: BoardInput = {
    detail: detailOf(generated),
    children: { run_child: { run: { id: "run_child" }, steps: generated.children!.run_child!.steps as never, definition: generated.children!.run_child!.definition as never } },
  };
  const waves = executionWaves(input)!;
  expect(waves.source).toBe("generated");
  expect(waves.waves.map(w => w.steps.map(s => s.stepId))).toEqual([["api"], ["ui", "docs"], ["tests"]]);
  const tests = waves.waves[2]!.steps[0]!;
  expect(tests.blocked).toBe(true);
  expect(tests.after).toEqual(["ui", "docs"]);
  // a loop back edge does not create a wave
  const looped = { ...input, children: { run_child: { ...input.children!.run_child!, definition: { ...(input.children!.run_child!.definition as object), edges: [...(input.children!.run_child!.definition as { edges: unknown[] }).edges, { from: "tests", to: "api", maxLoops: 2 }] } as never } } };
  expect(executionWaves(looped)!.waves).toHaveLength(3);
});

test("executionWaves falls back to the run's own steps when there is no child", () => {
  const w = executionWaves({ detail: detailOf(plain) })!;
  expect(w.source).toBe("plain");
  expect(w.waves.flatMap(x => x.steps.map(s => s.stepId))).toContain("approve_spec");
});

test("testsAndPr reads evidence, artifacts, branch and the publish question", () => {
  const input: BoardInput = {
    detail: detailOf(evidence), artifacts: evidence.get.artifacts, questions: evidence.questions as never,
  };
  const t = testsAndPr(input);
  expect(t.evidence).toHaveLength(1);
  expect(t.evidence[0]!.surfaces.map(s => [s.name, s.status])).toEqual([["web runs page", "pass"], ["desktop app", "fail"], ["tui", "unverified"]]);
  expect(t.evidence[0]!.surfaces[0]!.artifacts.map(a => a.label)).toEqual(["Runs page screenshot"]);
  expect(t.evidence[0]!.surfaces[2]!.missingArtifacts).toEqual(["art_zzzzzzzzzz"]);
  expect(t.evidence[0]!.report?.label).toBe("Evidence report");
  expect(t.branch).toBe("pacer/run-1");
  expect(t.prUrl).toBe("https://example.test/acme/web/pull/7");
  expect(t.publishQuestions.map(q => q.id)).toEqual(["q_pub"]);
  // a result without the evidence shape is not evidence
  expect(testsAndPr({ detail: detailOf(plain) }).evidence).toEqual([]);
});

test("conversationRail orders by time and marks messages to the planner", () => {
  const rail = conversationRail({
    decisions: plain.get.decisions, questions: [{ id: "q1", text: "Q?", status: "answered", answer: "approve", createdAt: 920 }], messages: [{ id: "m", from: "person", to: "task:t_orch", kind: "message", body: "hi", at: 915 }],
  }, "t_orch");
  expect(rail.map(e => e.kind)).toEqual(["decision", "message", "question"]);
  expect(rail[1]).toMatchObject({ kind: "message", mine: true });
});

test("boardAvailability offers only boards with data", () => {
  const bare = boardAvailability({ detail: { run: { id: "r" }, steps: [], graphs: [] } as unknown as RunDetail }, false);
  expect(bare).toEqual({ brainstorm: false, review: false, execution: false, tests: false });
  expect(boardAvailability({ detail: detailOf(fanout) }, true)).toMatchObject({ brainstorm: true, review: true });
  expect(boardAvailability({ detail: detailOf(evidence), artifacts: evidence.get.artifacts }, false).tests).toBe(true);
});

test("vocabulary: plain words for actors, kinds, evidence status and pause reasons", () => {
  expect(actorLabel("person")).toBe("You");
  expect(actorLabel("orchestrator")).toBe("Planner");
  expect(decisionKindLabel("publish_approved")).toBe("Approved publishing");
  expect(decisionKindLabel("some_new_kind")).toBe("some new kind");
  expect(evidenceStatusLabel("unverified")).toEqual({ label: "Unverified", tone: "warn", glyph: "?" });
  expect(pausedReasonLabel("pacing: emergency")).toBe("Paused to stay within your usage limits");
  expect(pausedReasonLabel("budget")).toContain("budget");
  expect(pausedReasonLabel("person")).toBe("Paused by you");
});

test("pickSpecArtifact prefers the requested id, then a spec-like label, then the newest", () => {
  const arts = artifactMetas([
    { id: "art_1", label: "Notes", name: "n.md", mime: "text/markdown", size: 1, stepId: "a" },
    { id: "art_2", label: "Spec v1", name: "spec.md", mime: "text/markdown", size: 1, stepId: "a" },
    { id: "art_3", label: "Other", name: "o.md", mime: "text/markdown", size: 1, stepId: "a" },
  ]);
  expect(pickSpecArtifact(arts)!.id).toBe("art_2");
  expect(pickSpecArtifact(arts, "art_3")!.id).toBe("art_3");
  expect(pickSpecArtifact(arts, "missing")!.id).toBe("art_2");
  expect(pickSpecArtifact(arts.filter(a => a.id !== "art_2"))!.id).toBe("art_3");
  expect(pickSpecArtifact([])).toBeUndefined();
});
