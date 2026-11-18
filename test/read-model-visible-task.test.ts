import { afterAll, beforeAll, expect, test } from "bun:test";
import { snapshotTasks } from "../src/api/read-model/tasks";
import { readModelCtx, buildRustProbe, rustRequest, closeRustProbe } from "./read-model-rust-helpers";
import { record } from "./read-model-helpers";
import type { Ctx } from "../src/types";
import type { TaskRecord } from "../src/tasks/types";

beforeAll(buildRustProbe, 600_000);
afterAll(closeRustProbe);

/**
 * P3 native-owner parity for `visibleTaskState` / `task_data` question and
 * updatedAt wiring. Runs actual TS `taskData` (through `snapshotTasks`) against
 * the actual Rust `task_data` row produced by the line-oriented probe for the
 * same input records, asserting serialized equality so key order is significant.
 */
function parityCtx(): Ctx {
  return readModelCtx({ which: () => null, readOnly: true });
}

async function expectRowParity(ctx: Ctx, tx: TaskRecord): Promise<Record<string, unknown>> {
  const rust = (await rustRequest(ctx, { op: "tasks", records: [tx] })) as Record<string, unknown>[];
  const expected = snapshotTasks(ctx, [tx]);
  expect(JSON.stringify(rust)).toBe(JSON.stringify(expected));
  expect(rust).toHaveLength(1);
  expect(expected).toHaveLength(1);
  return rust[0]!;
}

test("running with an unanswered question projects visibleTaskState needs_input", async () => {
  const ctx = parityCtx();
  const row = await expectRowParity(ctx, record("running", ctx.now, { question: { text: "Which path?", at: ctx.now + 100 } }));
  expect(row.state).toBe("needs_input");
  expect(row.question).toEqual({ text: "Which path?", at: ctx.now + 100 });
});

test("running question answered with null, false, or empty string stays running", async () => {
  const ctx = parityCtx();
  for (const answer of [null, false, ""]) {
    const row = await expectRowParity(ctx, record("running", ctx.now, { question: { text: "q", at: ctx.now, answer: answer as never } }));
    expect(row.state).toBe("running");
  }
});

test("absent, null, and false question keep running and drop the question field", async () => {
  const ctx = parityCtx();
  for (const question of [undefined, null, false]) {
    const row = await expectRowParity(ctx, record("running", ctx.now, { question: question as never }));
    expect(row.state).toBe("running");
    expect("question" in row).toBe(false);
  }
});

test("non-running task with a question keeps its real state and carries the question", async () => {
  const ctx = parityCtx();
  const row = await expectRowParity(ctx, record("done", ctx.now, { question: { text: "q", at: ctx.now } }));
  expect(row.state).toBe("done");
  expect(row.question).toEqual({ text: "q", at: ctx.now });
});

test("question.at dominates updatedAt for an unanswered running task", async () => {
  const ctx = parityCtx();
  const late = ctx.now + 500_000;
  const row = await expectRowParity(ctx, record("running", ctx.now, { question: { text: "q", at: late } }));
  expect(row.updatedAt).toBe(late);
});

test("question.answeredAt dominates updatedAt once answered", async () => {
  const ctx = parityCtx();
  const answeredLate = ctx.now + 900_000;
  const row = await expectRowParity(ctx, record("done", ctx.now, { question: { text: "q", at: ctx.now, answer: "ok", answeredAt: answeredLate } }));
  expect(row.updatedAt).toBe(answeredLate);
});

test("question is placed after placement and before interactionMode, preserving nested UTF-16", async () => {
  const ctx = parityCtx();
  const emojiQuestion = "Choose \u{1F642} and \u{10400}\u{1042C}?";
  const question = { text: emojiQuestion, at: ctx.now, meta: { note: "\u{1F680}" } };
  const tx = record("running", ctx.now, {
    placement: { mode: "new", why: "test", requested: "new" },
    interactionMode: "conversation",
    question,
  });
  const row = await expectRowParity(ctx, tx);
  const keys = Object.keys(row);
  expect(keys.indexOf("placement")).toBeGreaterThanOrEqual(0);
  expect(keys.indexOf("question")).toBeGreaterThan(keys.indexOf("placement"));
  expect(keys.indexOf("interactionMode")).toBeGreaterThan(keys.indexOf("question"));
  expect(row.placement).toEqual({ mode: "new", why: "test" });
  expect((row.question as { text: string }).text).toBe(emojiQuestion);
  expect((row.question as { meta?: { note: string } }).meta).toEqual({ note: "\u{1F680}" });
});