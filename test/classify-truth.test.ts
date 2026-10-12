import { expect, test } from "bun:test";
import { buildTruth, truthFor } from "../src/classify/truth";
import { QUESTIONS } from "../src/classify/state";
import type { DecisionEntry, DecisionName } from "../src/classify/types";
import { appendLabel } from "../src/tasks/labels";
import { createTask, updateTask } from "../src/tasks/store";
import type { TaskResult } from "../src/tasks/types";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

function task(ctx: Ctx, kind: string | null = "feature", status?: TaskResult["status"], executor: string | null = "codex") {
  const t = createTask(ctx, { brief: { goal: "Implement support", repo: "/tmp/repo" }, kind, requestedExecutor: null, timeoutS: 60 });
  if (status) updateTask(ctx, t.id, (record) => {
    record.state = status;
    record.result = { status, executor, model: null, report: "result", backend: "direct", files: "" };
  });
  return t.id;
}

function entry(decision: DecisionName, overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return { ts: 1, id: "d-acting", decision, state_hash: "hash-acting", state: null,
    question: QUESTIONS[decision], adapter: "rules", answer: { value: true, confidence: 1, latencyMs: 0 },
    acted_on: true, fallback: false, ...overrides };
}

test("task_kind truth comes from a review kind, otherwise a valid task tag", () => {
  const ctx = fakeCtx();
  const reviewed = task(ctx, "feature");
  const tagged = task(ctx, "tests");
  const invalid = task(ctx, "unknown");
  const untagged = task(ctx, null);
  appendLabel(ctx, { type: "task_review", task_id: reviewed, kind: "refactor", accepted: true });
  appendLabel(ctx, { type: "task_review", task_id: tagged, kind: "invalid", accepted: true });
  const index = buildTruth(ctx, [], { tiers: { codex: "cheap", opencode: "cheap" } });
  expect(index.taskKind[reviewed]).toBe("refactor");
  expect(index.taskKind[tagged]).toBe("tests");
  expect(index.taskKind[invalid]).toBeUndefined();
  expect(index.taskKind[untagged]).toBeUndefined();
  expect(truthFor(index, entry("task_kind", { task_id: reviewed }))).toBe("refactor");
});

test("difficulty reliable/unreliable comes from result status plus review", () => {
  const ctx = fakeCtx();
  const done = task(ctx, "feature", "done", "opencode");
  const rejected = task(ctx, "feature", "done");
  const partial = task(ctx, "feature", "partial");
  const failed = task(ctx, "feature", "failed", null);
  appendLabel(ctx, { type: "task_review", task_id: rejected, accepted: false });
  appendLabel(ctx, { type: "task_review", task_id: partial, accepted: true });
  const index = buildTruth(ctx, [], { tiers: { codex: "cheap", opencode: "cheap" } });
  expect(index.difficulty[done]).toEqual({ reliable: true, executor: "opencode" });
  expect(index.difficulty[rejected]).toEqual({ reliable: false, executor: "codex" });
  expect(index.difficulty[partial]).toEqual({ reliable: false, executor: "codex" });
  expect(index.difficulty[failed]).toBeUndefined();
  expect(truthFor(index, entry("difficulty", { task_id: partial }))).toBe(false);
});

test("difficulty has no truth for queued tasks or limit/stopped outcomes", () => {
  const ctx = fakeCtx();
  const ids = [task(ctx), task(ctx, null, "limit"), task(ctx, null, "stopped")];
  const index = buildTruth(ctx, [], { tiers: { codex: "cheap", opencode: "cheap" } });
  for (const id of ids) expect(index.difficulty[id]).toBeUndefined();
});

test("result_check truth comes only from review.accepted, preserving false", () => {
  const ctx = fakeCtx();
  const accepted = task(ctx);
  const rejected = task(ctx, "feature", "done");
  const unreviewed = task(ctx, "feature", "done");
  appendLabel(ctx, { type: "task_review", task_id: accepted, accepted: true });
  appendLabel(ctx, { type: "task_review", task_id: rejected, accepted: false });
  const index = buildTruth(ctx, [], { tiers: { codex: "cheap", opencode: "cheap" } });
  expect(truthFor(index, entry("result_check", { task_id: accepted }))).toBe(true);
  expect(truthFor(index, entry("result_check", { task_id: rejected }))).toBe(false);
  expect(index.resultCheck[unreviewed]).toBeUndefined();
});

test("guard_feedback matches acted entries by state_hash or id and correct/incorrect labels", () => {
  const ctx = fakeCtx();
  const entries = [entry("guard"), entry("guard", { id: "d-second", state_hash: "hash-second", answer: { value: false, confidence: 1, latencyMs: 0 } }),
    entry("guard", { id: "d-shadow", state_hash: "hash-shadow", acted_on: false })];
  appendLabel(ctx, { type: "guard_feedback", event_id: "hash-acting", correct: true });
  appendLabel(ctx, { type: "guard_feedback", event_id: "d-second", correct: false });
  appendLabel(ctx, { type: "guard_feedback", event_id: "d-shadow", correct: true });
  const index = buildTruth(ctx, entries);
  expect(index.guard["hash-acting"]).toBe(true);
  expect(index.guard["hash-second"]).toBe(true);
  expect(index.guard["hash-shadow"]).toBeUndefined();
  expect(truthFor(index, entries[1])).toBe(true);
});

test("guard_override sets execution truth to false by hash or decision id", () => {
  const ctx = fakeCtx();
  const entries = [entry("guard"), entry("guard", { id: "d-second", state_hash: "hash-second" })];
  appendLabel(ctx, { type: "guard_override", event_id: "hash-acting" });
  appendLabel(ctx, { type: "guard_override", event_id: "d-second" });
  const index = buildTruth(ctx, entries);
  for (const e of entries) expect(truthFor(index, e)).toBe(false);
});

test("the latest task review wins for kind, difficulty and result_check", () => {
  const ctx = fakeCtx();
  const id = task(ctx, "feature", "done");
  appendLabel(ctx, { type: "task_review", task_id: id, kind: "tests", accepted: false });
  appendLabel(ctx, { type: "task_review", task_id: id, kind: "docs", accepted: true });
  const index = buildTruth(ctx, [], { tiers: { codex: "cheap", opencode: "cheap" } });
  expect(index.taskKind[id]).toBe("docs");
  expect(index.difficulty[id]?.reliable).toBe(true);
  expect(index.resultCheck[id]).toBe(true);
});

test("the latest guard label wins across feedback and overrides", () => {
  const ctx = fakeCtx();
  const e = entry("guard");
  appendLabel(ctx, { type: "guard_feedback", event_id: e.id, correct: false });
  appendLabel(ctx, { type: "guard_feedback", event_id: e.state_hash, correct: true });
  expect(truthFor(buildTruth(ctx, [e]), e)).toBe(true);
  appendLabel(ctx, { type: "guard_override", event_id: e.id });
  expect(truthFor(buildTruth(ctx, [e]), e)).toBe(false);
  appendLabel(ctx, { type: "guard_feedback", event_id: e.id, correct: true });
  expect(truthFor(buildTruth(ctx, [e]), e)).toBe(true);
});

test("missing truth, unmatched feedback and non-boolean guard answers stay unlabelled", () => {
  const ctx = fakeCtx();
  const e = entry("guard", { answer: null });
  appendLabel(ctx, { type: "guard_feedback", event_id: e.id, correct: false });
  appendLabel(ctx, { type: "guard_feedback", event_id: "unknown", correct: true });
  const index = buildTruth(ctx, [e]);
  expect(truthFor(index, e)).toBeUndefined();
  for (const decision of ["task_kind", "difficulty", "result_check"] as const) {
    expect(truthFor(index, entry(decision))).toBeUndefined();
  }
});


test("difficulty truth is limited to configured cheap executors", () => {
  const ctx = fakeCtx();
  const cheap = task(ctx, "feature", "done", "cheap");
  const capable = task(ctx, "feature", "failed", "capable");
  const unknown = task(ctx, "feature", "done", "unknown");
  const missing = task(ctx, "feature", "failed", null);
  const index = buildTruth(ctx, [], { tiers: { cheap: "cheap", capable: "capable" } });
  expect(index.difficulty[cheap]?.reliable).toBe(true);
  for (const id of [capable, unknown, missing]) expect(truthFor(index, entry("difficulty", { task_id: id }))).toBeUndefined();
});
