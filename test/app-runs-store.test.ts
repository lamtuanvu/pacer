import { expect, test } from "bun:test";
import type { AttentionItem } from "../src/attention/types";
import {
  buildRunsListState,
  initialRunsStore,
  questionFromAttention,
  questionFromEntity,
  runAttentionQueue,
} from "../app/src/data/runs";
import { initialState, reduceStore } from "../app/src/data/store";
import { RUNS_EMPTY, RUNS_UNAVAILABLE } from "../src/view-model/runs";

function attentionQuestion(overrides: Partial<AttentionItem> & { runId?: string } = {}): AttentionItem {
  const runId = overrides.runId ?? "run_a";
  return {
    id: overrides.id ?? `att:${runId}`,
    kind: "question",
    severity: "decide",
    repo: null,
    title: overrides.title ?? "Pick a plan",
    detail: "detail",
    raisedAt: 100,
    since: 100,
    actions: [],
    notify: "all",
    unblocks: overrides.unblocks ?? "run",
    run: overrides.run ?? { id: runId, letter: "A", title: "Feature X", priority: "urgent" },
    question: overrides.question ?? {
      id: "q_1",
      rev: 1,
      answerType: "yes_no",
      text: "Ship it?",
      blocks: "step",
    },
    ...overrides,
  };
}

test("runAttentionQueue keeps only person-answerable run questions in attention order", () => {
  const items: AttentionItem[] = [
    attentionQuestion({ id: "a1", runId: "run_1", unblocks: "run" }),
    { ...attentionQuestion({ id: "a2" }), kind: "review", question: undefined, run: undefined },
    attentionQuestion({ id: "a3", runId: "run_2", unblocks: "nothing" }),
  ];
  const queue = runAttentionQueue(items);
  expect(queue.map(i => i.id)).toEqual(["a1", "a3"]);
});

test("questionFromAttention fails closed on malformed questions", () => {
  expect(questionFromAttention(attentionQuestion({ question: { id: "q", rev: 1, answerType: "nope" } }))).toBeUndefined();
  expect(questionFromAttention(attentionQuestion({ question: { id: "q", rev: "x", answerType: "text" } }))).toBeUndefined();
  const ok = questionFromAttention(attentionQuestion());
  expect(ok?.answerType).toBe("yes_no");
  expect(ok?.id).toBe("q_1");
});

test("questionFromEntity maps question.get payloads including suggested", () => {
  const view = questionFromEntity({
    id: "q_9",
    rev: 4,
    answerType: "single",
    text: "Which?",
    options: [{ value: "a" }, { value: "b" }],
    blocks: "branch",
    suggested: "a",
    recommended: "a",
  }, "run_1");
  expect(view).toMatchObject({
    id: "q_9",
    runId: "run_1",
    rev: 4,
    suggestedAnswer: "a",
    recommended: "a",
  });
});

test("questionFromEntity preserves artifact, stepId, attempt and branch", () => {
  const asString = questionFromEntity({
    id: "q_art",
    rev: 2,
    answerType: "text",
    text: "See artifact",
    blocks: "step",
    artifact: "art_1",
    stepId: "human_gate",
    attempt: 3,
    branch: "left",
  }, "run_2");
  expect(asString).toMatchObject({
    id: "q_art",
    artifact: { id: "art_1" },
    stepId: "human_gate",
    attempt: 3,
    branch: "left",
  });

  const asObject = questionFromEntity({
    id: "q_art2",
    rev: 1,
    answerType: "yes_no",
    text: "?",
    blocks: "run",
    artifact: { id: "art_9", label: "Diff" },
    stepId: "review",
    attempt: 1,
  }, "run_3");
  expect(asObject).toMatchObject({
    artifact: { id: "art_9", label: "Diff" },
    stepId: "review",
    attempt: 1,
  });
});

test("reduceStore bumps invalidations.runs on workflow entity SSE events", () => {
  let state = reduceStore(initialState(), {
    type: "snapshot",
    snapshot: { seq: 1, at: 1, tasks: [], attention: [], counts: { attention: 0, running: 0, queued: 0, review: 0, failed: 0, setupOpen: 0 } } as never,
  });
  expect(state.invalidations.runs ?? 0).toBe(0);
  for (const type of ["run", "step", "decision", "question"] as const) {
    state = reduceStore(state, {
      type: "event",
      event: { type, seq: state.snapshot!.seq + 1, at: 2, data: { id: `${type}_1` } },
    });
    expect(state.invalidations.runs).toBeGreaterThan(0);
  }
  expect(state.invalidations.runs).toBe(4);
  expect(state.snapshot!.seq).toBe(5);
});

test("buildRunsListState shows em dash age when snapshot-only rows lack createdAt", () => {
  const store = initialRunsStore();
  const withSnap = buildRunsListState({
    ops: new Set(["run.list"]),
    attention: [],
    snapshotRuns: [{
      id: "run_z",
      letter: "Z",
      title: "Zulu",
      workflow: "pacer-dev/dev",
      status: "waiting",
      priority: "urgent",
      waits_on: "you",
      steps: { running: 0, waiting: 1, done: 0, failed: 0 },
      orchestrator: { state: "idle" },
    }],
    store,
    now: 1_800_000_000,
  });
  expect(withSnap.runs).toHaveLength(1);
  expect(withSnap.runs[0]!.createdAt).toBe(0);
  expect(withSnap.runs[0]!.age).toBe("—");
  expect(withSnap.runs[0]!.age).not.toMatch(/\d{4,}d ago/);
});

test("buildRunsListState ranks queue from attention and surfaces empty/error/unavailable", () => {
  const store = initialRunsStore();
  const empty = buildRunsListState({
    ops: new Set(["run.list"]),
    attention: [],
    snapshotRuns: undefined,
    store,
    now: 200,
  });
  expect(empty.empty).toBe(true);
  expect(empty.badge).toBe(0);

  const unavailable = buildRunsListState({
    ops: new Set(["task.list"]),
    attention: [attentionQuestion()],
    snapshotRuns: undefined,
    store,
    now: 200,
  });
  expect(unavailable.unavailable).toBe(true);
  expect(unavailable.badge).toBe(1);

  const errored = buildRunsListState({
    ops: new Set(["run.list"]),
    attention: [],
    snapshotRuns: undefined,
    store: { ...store, listError: "boom" },
    now: 200,
  });
  expect(errored.error).toBe("boom");

  const withSnap = buildRunsListState({
    ops: new Set(["run.list", "question.answer"]),
    attention: [attentionQuestion({ id: "a1", runId: "run_z" })],
    snapshotRuns: [{
      id: "run_z",
      letter: "Z",
      title: "Zulu",
      workflow: "pacer-dev/dev",
      status: "waiting",
      priority: "urgent",
      waits_on: "you",
      steps: { running: 0, waiting: 1, done: 0, failed: 0 },
      orchestrator: { state: "idle" },
    }],
    store,
    now: 200,
  });
  expect(withSnap.queue).toHaveLength(1);
  expect(withSnap.runs[0]!.letter).toBe("Z");
  expect(withSnap.runs[0]!.waitsOn).toBe("You");
  expect(withSnap.badge).toBe(1);
});

test("empty and unavailable copy match shared vocabulary", () => {
  expect(RUNS_EMPTY).toContain("pacer run start");
  expect(RUNS_UNAVAILABLE).toBe("Runs unavailable.");
});
