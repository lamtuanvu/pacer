import { expect, test } from "bun:test";
import type { AttentionItem } from "../src/attention/types";
import {
  applyRunsEntityEvent,
  buildRunsListState,
  initialRunsStore,
  questionFromAttention,
  runAttentionQueue,
  runLetterToneIndex,
} from "../app/src/data/runs";
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

test("applyRunsEntityEvent upserts and removes run rows", () => {
  let state = initialRunsStore();
  state = applyRunsEntityEvent(state, "run", {
    id: "run_1",
    workflow: "pacer-dev/dev",
    title: "One",
    status: "running",
    priority: "normal",
    letter: "A",
    createdAt: 10,
  });
  expect(state.list).toHaveLength(1);
  expect(state.list[0]!.title).toBe("One");
  state = applyRunsEntityEvent(state, "run", {
    id: "run_1",
    workflow: "pacer-dev/dev",
    title: "One updated",
    status: "waiting",
    priority: "urgent",
    letter: "A",
    createdAt: 10,
  });
  expect(state.list[0]!.title).toBe("One updated");
  expect(state.list[0]!.status).toBe("waiting");
  state = applyRunsEntityEvent(state, "run", { id: "run_1", removed: true });
  expect(state.list).toHaveLength(0);
});

test("applyRunsEntityEvent patches detail questions and decisions", () => {
  let state = initialRunsStore();
  state = {
    ...state,
    details: {
      run_1: {
        id: "run_1",
        run: { id: "run_1" },
        steps: [],
        questions: [],
        decisions: [],
        loading: false,
        error: null,
        stamp: 0,
      },
    },
  };
  state = applyRunsEntityEvent(state, "question", {
    id: "q_9",
    runId: "run_1",
    rev: 2,
    answerType: "single",
    text: "Which?",
    options: [{ value: "a" }, { value: "b" }],
    blocks: "branch",
  });
  expect(state.details.run_1!.questions[0]!.id).toBe("q_9");
  state = applyRunsEntityEvent(state, "decision", {
    id: "d_1",
    runId: "run_1",
    kind: "choose",
    choice: "a",
  });
  expect(state.details.run_1!.decisions).toHaveLength(1);
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

test("runLetterToneIndex is stable for a letter", () => {
  expect(runLetterToneIndex("A")).toBe(runLetterToneIndex("A"));
  expect(runLetterToneIndex("B")).not.toBe(runLetterToneIndex("A"));
});

test("empty and unavailable copy match shared vocabulary", () => {
  expect(RUNS_EMPTY).toContain("pacer run start");
  expect(RUNS_UNAVAILABLE).toBe("Runs unavailable.");
});
