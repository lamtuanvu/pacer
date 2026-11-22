import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { CoreError } from "../src/core/errors";
import { questionInputSchema } from "../src/workflow/question-schema";
import {
  answerQuestionRecord,
  getQuestion,
  insertQuestion,
  listQuestions,
  workflowDatabase,
} from "../src/workflow/store";
import { insertRun } from "../src/workflow/store";
import { tmpDir } from "./helpers";

test("QuestionInput rejects text over 1000 and more than 12 options", () => {
  expect(() => questionInputSchema.parse({
    text: "x".repeat(1001),
    answerType: "text",
    blocks: "nothing",
  })).toThrow();
  expect(() => questionInputSchema.parse({
    text: "ok",
    answerType: "single",
    blocks: "step",
    options: Array.from({ length: 13 }, (_, i) => ({ value: `o${i}` })),
  })).toThrow();
});

test("QuestionInput rejects option notes over 500 and recommended not in options", () => {
  expect(() => questionInputSchema.parse({
    text: "pick",
    answerType: "single",
    blocks: "step",
    options: [{ value: "a", note: "n".repeat(501) }],
    recommended: "a",
  })).toThrow();
  expect(() => questionInputSchema.parse({
    text: "pick",
    answerType: "single",
    blocks: "step",
    options: [{ value: "a" }, { value: "b" }],
    recommended: "c",
  })).toThrow(/recommended/);
});

test("QuestionInput accepts approve_revise with options and recommended", () => {
  const parsed = questionInputSchema.parse({
    text: "Ship it?",
    answerType: "approve_revise",
    blocks: "step",
    options: [{ value: "approve" }, { value: "revise", note: "needs work" }],
    recommended: "approve",
  });
  expect(parsed.recommended).toBe("approve");
  expect(parsed.options?.[1]?.note).toBe("needs work");
});

test("one question row per insert; ids are q_ + 10 base32", () => {
  const ctx = fakeCtx();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "B", title: "T" });
  const q = insertQuestion(ctx, {
    runId: run.id,
    stepId: "ask",
    attempt: 1,
    askerKind: "executor",
    askerTaskId: "t-1",
    text: "Which?",
    answerType: "single",
    options: [{ value: "a" }, { value: "b" }],
    recommended: "a",
    blocks: "step",
    answerer: "orchestrator",
  });
  expect(q.id).toMatch(/^q_[a-z2-7]{10}$/);
  expect(q.status).toBe("open");
  expect(q.rev).toBe(1);
  expect(getQuestion(ctx, q.id)).toMatchObject({ id: q.id, text: "Which?", answerer: "orchestrator" });
  expect(listQuestions(ctx, run.id)).toHaveLength(1);
  const cols = workflowDatabase(ctx).query<{ name: string }, []>("PRAGMA table_info(workflow_questions)").all().map(c => c.name);
  expect(cols).toContain("answer_type");
  expect(cols).toContain("asker_kind");
});

test("answerQuestionRecord requires expect_rev and rejects stale rev", () => {
  const ctx = fakeCtx();
  const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "B", title: "T" });
  const q = insertQuestion(ctx, {
    runId: run.id,
    stepId: "ask",
    attempt: 1,
    askerKind: "human_step",
    text: "Go?",
    answerType: "yes_no",
    blocks: "step",
    answerer: "person",
  });
  expect(() => answerQuestionRecord(ctx, q.id, { answer: "yes", expectRev: q.rev - 1, answeredBy: "person" }))
    .toThrow(CoreError);
  const answered = answerQuestionRecord(ctx, q.id, { answer: "yes", expectRev: q.rev, answeredBy: "person" });
  expect(answered.status).toBe("answered");
  expect(answered.answer).toBe("yes");
  expect(answered.rev).toBe(q.rev + 1);
  expect(answered.answeredAt).toBe(ctx.now);
  expect(() => answerQuestionRecord(ctx, q.id, { answer: "no", expectRev: answered.rev, answeredBy: "person" }))
    .toThrow(/conflict/);
});
