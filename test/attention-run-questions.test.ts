import { afterAll, beforeAll, expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { deriveItems, sortItems, type RuleInput } from "../src/attention/rules";
import { apiTask } from "../src/api/read-model/tasks";
import { toV2Snapshot, isWorkflowAttentionItem } from "../src/api/v2-compat";
import { deriveWorkflowAttention } from "../src/workflow/attention";
import {
  insertQuestion,
  insertRun,
  workflowDatabase,
  type QuestionBlocks,
} from "../src/workflow/store";
import type { AttentionItem } from "../src/attention/types";
import { record } from "./read-model-helpers";
import { buildRustProbe, closeRustProbe, rustRequest } from "./read-model-rust-helpers";

const NOW = 1_700_000_000;

function baseInput(): RuleInput {
  return {
    now: NOW,
    tasks: [],
    executors: [],
    accounts: [],
    planner: null,
    setup: { complete: true, open: 0, items: [] },
    update: null,
    retryTarget: () => null,
  };
}

function seedPersonQuestion(
  ctx: ReturnType<typeof fakeCtx>,
  opts: { title: string; blocks: QuestionBlocks; createdAt: number; text?: string },
) {
  workflowDatabase(ctx);
  const run = insertRun(
    { ...ctx, now: opts.createdAt },
    { workflow: "t/attn", version: 1, repo: tmpDir(), brief: "B", title: opts.title },
  );
  const q = insertQuestion(
    { ...ctx, now: opts.createdAt },
    {
      runId: run.id,
      stepId: "ask",
      attempt: 1,
      askerKind: "executor",
      askerTaskId: "t-ask",
      text: opts.text ?? opts.title,
      answerType: "single",
      options: [{ value: "a" }, { value: "b" }],
      recommended: "a",
      blocks: opts.blocks,
      answerer: "person",
    },
  );
  return { run, q };
}

test("open person-answerer questions become v3 attention items with run identity", () => {
  const ctx = { ...fakeCtx(), now: NOW };
  const { run, q } = seedPersonQuestion(ctx, { title: "Ship?", blocks: "step", createdAt: NOW - 10 });
  // Orchestrator-answerer questions stay off the person queue.
  insertQuestion(ctx, {
    runId: run.id,
    stepId: "later",
    attempt: 1,
    askerKind: "executor",
    text: "Internal?",
    answerType: "text",
    blocks: "nothing",
    answerer: "orchestrator",
  });

  const items = deriveWorkflowAttention(ctx);
  const item = items.find(i => i.id === `question:${q.id}`);
  expect(item).toBeTruthy();
  expect(item).toMatchObject({
    kind: "question",
    severity: "blocked",
    unblocks: "run",
    detail: "Ship?",
    run: { id: run.id, title: "Ship?", priority: "normal" },
    question: { id: q.id, text: "Ship?", answerType: "single", blocks: "step" },
  });
  expect(typeof item!.run!.letter).toBe("string");
  expect(item!.run!.letter.length).toBe(1);
  expect(item!.actions.some(a => a.op === "question.answer")).toBe(true);
  expect(isWorkflowAttentionItem(item!)).toBe(true);
  expect(items.some(i => i.detail === "Internal?")).toBe(false);
});

test("run questions rank by unblocks (run > branch > nothing), then age", () => {
  const ctx = { ...fakeCtx(), now: NOW };
  const nothing = seedPersonQuestion(ctx, { title: "Info", blocks: "nothing", createdAt: NOW - 30 });
  const branch = seedPersonQuestion(ctx, { title: "Branch", blocks: "branch", createdAt: NOW - 10 });
  const runQ = seedPersonQuestion(ctx, { title: "Run", blocks: "step", createdAt: NOW - 5 });
  const olderRun = seedPersonQuestion(ctx, { title: "Older run", blocks: "step", createdAt: NOW - 20 });

  const ranked = deriveWorkflowAttention(ctx)
    .filter(i => i.unblocks)
    .map(i => i.id);
  expect(ranked).toEqual([
    `question:${olderRun.q.id}`,
    `question:${runQ.q.id}`,
    `question:${branch.q.id}`,
    `question:${nothing.q.id}`,
  ]);
});

test("ordinary task question attention items are unchanged", () => {
  const ctx = fakeCtx();
  const raw = record("needs_input", ctx.now);
  raw.question = { text: "which db?", at: ctx.now - 10 };
  const t = apiTask(ctx, raw);
  const items = deriveItems({ ...baseInput(), now: ctx.now, tasks: [t] });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    id: `question:${t.id}`,
    kind: "question",
    severity: "blocked",
    detail: "which db?",
  });
  expect(items[0]!.run).toBeUndefined();
  expect(items[0]!.unblocks).toBeUndefined();
  expect(isWorkflowAttentionItem(items[0]!)).toBe(false);
});

test("v2 snapshot strips run-question attention and keeps ordinary task questions", () => {
  const ordinary: AttentionItem = {
    id: "question:t-keep",
    kind: "question",
    severity: "blocked",
    repo: null,
    title: "Task ask",
    detail: "which?",
    raisedAt: 1,
    since: 1,
    actions: [{ label: "Answer", op: "task.answer", params: { id: "t-keep" } }],
    notify: "important",
  };
  const runQuestion: AttentionItem = {
    id: "question:q_abcdefghij",
    kind: "question",
    severity: "blocked",
    repo: null,
    title: "Run ask",
    detail: "pick",
    raisedAt: 1,
    since: 1,
    actions: [{ label: "Answer", op: "question.answer", params: { id: "q_abcdefghij" } }],
    notify: "important",
    unblocks: "run",
    run: { id: "run_x", letter: "A", title: "T", priority: "normal" },
    question: { id: "q_abcdefghij", text: "pick", answerType: "text", blocks: "step" },
  };
  expect(isWorkflowAttentionItem(runQuestion)).toBe(true);
  expect(isWorkflowAttentionItem(ordinary)).toBe(false);

  const v2 = toV2Snapshot({
    seq: 3_000_000_000_000,
    at: 42,
    mode: "normal",
    tasks: [],
    strategies: [],
    planner: { runner: "p", mode: "normal", stale: false },
    accounts: [],
    executors: [],
    machine: { used: 0, max: 1, hardCap: null, unlimited: false },
    setup: { items: [] },
    attention: [runQuestion, ordinary],
    counts: { attention: 2, problems: 2, review: 0, running: 0, queued: 0, ready: 0, executors: 0, setupOpen: 0, hostsWithProblems: 0, byRepo: [] },
  } as unknown as Parameters<typeof toV2Snapshot>[0]);
  expect(v2.attention.map(a => a.id)).toEqual(["question:t-keep"]);
});

test("v2 snapshot strips promptWait from tasks (M-g)", () => {
  // Live Q9: /v2/snapshot still carried promptWait on tasks while ops stripped it.
  // Snapshot tasks keep additive fields (fullTitle/derived); only promptWait is stripped.
  const v2 = toV2Snapshot({
    seq: 3_000_000_000_000,
    at: 42,
    mode: "normal",
    tasks: [
      {
        id: "t-wait",
        state: "running",
        promptWait: { text: "Proceed? (y/n)", at: 1 },
        fullTitle: "full",
        derived: {},
      },
    ],
    strategies: [],
    planner: { runner: "p", mode: "normal", stale: false },
    accounts: [],
    executors: [],
    machine: { used: 0, max: 1, hardCap: null, unlimited: false },
    setup: { items: [] },
    attention: [],
    counts: { attention: 0, problems: 0, review: 0, running: 0, queued: 0, ready: 0, executors: 0, setupOpen: 0, hostsWithProblems: 0, byRepo: [] },
  } as unknown as Parameters<typeof toV2Snapshot>[0]);
  const task = (v2 as unknown as { tasks: Record<string, unknown>[] }).tasks[0]!;
  expect(task.id).toBe("t-wait");
  expect(task.promptWait).toBeUndefined();
  expect(task.fullTitle).toBe("full");
  expect(task.derived).toEqual({});
  expect(JSON.stringify(v2)).not.toContain("promptWait");
});

beforeAll(buildRustProbe, 600_000);
afterAll(closeRustProbe);

test("TS and Rust run-question attention JSON are byte-identical over one fixture", async () => {
  const ctx = { ...fakeCtx(), now: NOW };
  const { q } = seedPersonQuestion(ctx, {
    title: "Parity?",
    blocks: "step",
    createdAt: NOW - 10,
    text: "Parity pick?",
  });
  const ts = deriveWorkflowAttention(ctx).filter(i => i.id.startsWith("question:q_"));
  const rust = await rustRequest(ctx, { op: "run_questions" }) as AttentionItem[];
  expect(JSON.stringify(rust)).toBe(JSON.stringify(ts));
  expect(rust[0]?.id).toBe(`question:${q.id}`);
}, 120_000);

test("sortItems ranks run questions by unblocks before ordinary severity peers of equal since", () => {
  const items: AttentionItem[] = [
    {
      id: "question:q_nothingxx",
      kind: "question",
      severity: "blocked",
      repo: null,
      title: "n",
      detail: "n",
      raisedAt: 5,
      since: 5,
      actions: [],
      notify: "important",
      unblocks: "nothing",
      run: { id: "r1", letter: "A", title: "t", priority: "normal" },
    },
    {
      id: "question:q_runxxxxxx",
      kind: "question",
      severity: "blocked",
      repo: null,
      title: "r",
      detail: "r",
      raisedAt: 5,
      since: 5,
      actions: [],
      notify: "important",
      unblocks: "run",
      run: { id: "r2", letter: "B", title: "t", priority: "normal" },
    },
  ];
  expect(sortItems([...items]).map(i => i.id)).toEqual([
    "question:q_runxxxxxx",
    "question:q_nothingxx",
  ]);
});
