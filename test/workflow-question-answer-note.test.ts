/** question.answer note schema, trim, sanitize, and grant must-step refusal (batch E). */
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import { callOp, type OpDeps } from "../src/api/ops";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, getQuestion, getRun, listQuestions, stepsOfRun,
} from "../src/workflow/store";
import { onTaskSettled, recordStepResult, startRun, type EngineDeps } from "../src/workflow/engine";
import { issueRunGrant } from "../src/workflow/run-grant";
import { insertTurn } from "../src/workflow/wakeups";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";
import { NOTE_TOO_LONG } from "../src/workflow/question-schema";

const NOW = 1_700_000_000;

const looped: WorkflowDef = {
  id: "t/q-answer-note",
  version: 1,
  steps: {
    brainstorm: {
      type: "agent",
      kind: "research",
      prompt: "Draft",
    },
    approve_spec: {
      type: "human",
      decision: "must",
      question: { text: "Approve?", kind: "approve_revise", options: ["approve", "revise"] },
    },
    done: { type: "end" },
  },
  edges: [
    { from: "brainstorm", to: "approve_spec" },
    { from: "approve_spec", to: "done", when: "result.answer == 'approve'" },
    { from: "approve_spec", to: "brainstorm", when: "result.answer == 'revise'", maxLoops: 3 },
  ],
  entry: "brainstorm",
};

function withStrategy(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
}

function fakeDeps() {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: EngineDeps["delegate"] = async (ctx, input: DelegateInput) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return readTask(ctx, prior.id) ?? prior;
    const task = createTask(ctx, {
      brief: input.brief,
      kind: input.kind ?? null,
      requestedExecutor: null,
      timeoutS: 600,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  const deps = {
    delegate,
    stopTask: (ctx: Ctx, id: string) => { updateTask(ctx, id, t => { t.state = "stopped"; }); },
  } satisfies EngineDeps;
  const opDeps: OpDeps = { delegate, spawnRunner: () => 1 };
  return { deps, opDeps };
}

async function reachApprove(ctx: Ctx, deps: EngineDeps): Promise<{ runId: string }> {
  addDefinition(ctx, looped, "src");
  const run = await startRun(ctx, { workflow: "t/q-answer-note", repo: tmpDir(), brief: "Ship it" }, undefined, deps);
  const draft = stepsOfRun(ctx, run.id).find(s => s.stepId === "brainstorm")!;
  recordStepResult(ctx, draft.taskId!, { ok: true, draft: "v1" });
  updateTask(ctx, draft.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, draft.taskId!, undefined, deps);
  expect(getRun(ctx, run.id)?.status).toBe("waiting");
  expect(listQuestions(ctx, run.id, "open")[0]?.stepId).toBe("approve_spec");
  return { runId: run.id };
}

test("callOp question.answer 4001-char note uses answerNoteSchema message", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  const { deps, opDeps } = fakeDeps();
  const { runId } = await reachApprove(ctx, deps);
  const q = listQuestions(ctx, runId, "open")[0]!;
  try {
    await callOp(ctx, "question.answer", {
      id: q.id,
      answer: "revise",
      note: "n".repeat(4001),
      expect_rev: q.rev,
    }, opDeps);
    throw new Error("expected refuse");
  } catch (e) {
    expect(e).toMatchObject({
      code: "invalid_input",
      message: `note: ${NOTE_TOO_LONG}`,
    } satisfies Partial<CoreError>);
  }
  expect(getQuestion(ctx, q.id)?.status).toBe("open");
});

test("whitespace-only note is dropped on question.answer (no fenced spaces)", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  const { deps, opDeps } = fakeDeps();
  const { runId } = await reachApprove(ctx, deps);
  const q = listQuestions(ctx, runId, "open")[0]!;
  const answered = await callOp(ctx, "question.answer", {
    id: q.id,
    answer: "revise",
    note: "   \t  ",
    expect_rev: q.rev,
  }, opDeps) as { note?: string; answer?: string };
  // Stored answer may be JSON with note omitted.
  expect(answered.note).toBeUndefined();
  if (typeof answered.answer === "string" && answered.answer.startsWith("{")) {
    expect(JSON.parse(answered.answer).note).toBeUndefined();
  }
  const step = stepsOfRun(ctx, runId).find(s => s.stepId === "approve_spec" && s.status === "done");
  expect((step?.result as { note?: string } | undefined)?.note).toBeUndefined();
});

test("control characters strip; empty-after-strip drops the note", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  const { deps, opDeps } = fakeDeps();
  const { runId } = await reachApprove(ctx, deps);
  const q = listQuestions(ctx, runId, "open")[0]!;
  const answered = await callOp(ctx, "question.answer", {
    id: q.id,
    answer: "revise",
    note: "\u0001\u0002\u0003",
    expect_rev: q.rev,
  }, opDeps) as { note?: string; answer?: string };
  expect(answered.note).toBeUndefined();
  if (typeof answered.answer === "string" && answered.answer.startsWith("{")) {
    expect(JSON.parse(answered.answer).note).toBeUndefined();
  }
});

test("grant caller cannot answer a must human step even with a note", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  const { deps, opDeps } = fakeDeps();
  const { runId } = await reachApprove(ctx, deps);
  const q = listQuestions(ctx, runId, "open")[0]!;
  expect(q.askerKind).toBe("human_step");
  expect(q.answerer).toBe("person");
  const turn = insertTurn(ctx, {
    id: "turn-grant-note",
    runId,
    planner: "claude-code",
    status: "running",
    startedAt: ctx.now,
    deadline: ctx.now + 600,
  });
  const grant = issueRunGrant(ctx, { runId, turnId: turn.id, deadline: ctx.now + 600 });
  const grantCtx: Ctx = {
    ...ctx,
    env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" },
  };
  await expect(callOp(grantCtx, "question.answer", {
    id: q.id,
    answer: "revise",
    note: "orchestrator note",
    expect_rev: q.rev,
  }, opDeps)).rejects.toMatchObject({
    code: "not_allowed",
    message: expect.stringMatching(/Only the person|cannot answer/i),
  });
  expect(getQuestion(ctx, q.id)?.status).toBe("open");
  expect(getRun(ctx, runId)?.status).toBe("waiting");
});
