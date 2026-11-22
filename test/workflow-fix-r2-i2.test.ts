import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { addDefinition, getQuestion, insertRun, insertStep } from "../src/workflow/store";
import { issueRunGrant } from "../src/workflow/run-grant";
import { insertTurn } from "../src/workflow/wakeups";
import { askQuestion, escalateQuestion } from "../src/workflow/questions";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";
import * as msgStore from "../src/messaging/store";
import { CoreError } from "../src/core/errors";

const NOW = 1_700_000_000;

const def: WorkflowDef = {
  id: "t/r2i2",
  version: 1,
  steps: {
    ask: { type: "agent", kind: "research", prompt: "Ask" },
    done: { type: "end" },
  },
  edges: [{ from: "ask", to: "done" }],
  entry: "ask",
};

function setup(ctx: Ctx) {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  addDefinition(ctx, def, "id: t/r2i2\n");
  const run = insertRun(ctx, { workflow: "t/r2i2", version: 1, repo: tmpDir(), brief: "B", title: "Q" });
  const task = createTask(ctx, {
    brief: { goal: "Ask", repo: run.repo },
    kind: "research",
    requestedExecutor: null,
    timeoutS: 600,
  });
  updateTask(ctx, task.id, t => {
    t.state = "running";
    t.run = {
      dir: tmpDir(), attempt: 1, executor: "codex", startedAt: ctx.now, mode: "new",
      workdir: run.repo, logFile: "/dev/null", agentSession: { id: "sid-1", source: "header" },
    };
  });
  insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, taskId: task.id, status: "running" });
  return { runId: run.id, task: readTask(ctx, task.id)! };
}

function needsInput(ctx: Ctx, taskId: string, text: string) {
  updateTask(ctx, taskId, t => {
    t.state = "needs_input";
    t.question = { text, at: ctx.now };
    t.attempts = [{
      executor: "codex", model: null, startedAt: ctx.now - 1, endedAt: ctx.now,
      exitCode: 0, timedOut: false, limitHit: false, log: "",
    }];
    t.result = {
      status: "needs_input", executor: "codex", model: null, files: "", report: "waiting", backend: "direct",
    };
  });
}

function personCtx(ctx: Ctx): Ctx {
  const env = { ...ctx.env };
  delete env.PACER_RUN_GRANT;
  delete env.PACER_ROLE;
  delete env.PACER_TASK_ID;
  return { ...ctx, env };
}

/** Extra from:human messages (the stray prompt-convert fall-through), not the resume answer. */
function strayHumanMessages(ctx: Ctx, taskId: string, body: string): number {
  return msgStore.thread(ctx, taskId).filter(m => m.kind === "message" && m.from === "human" && m.body === body).length;
}

function answerMessages(ctx: Ctx, taskId: string, body: string): number {
  return msgStore.thread(ctx, taskId).filter(m => m.kind === "answer" && m.body === body).length;
}

test("R2-I2: stale expect_rev does not deliver; correct retry delivers exactly once", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setup(ctx);
  const asked = await askQuestion(
    { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id } },
    { text: "Ship?", answerType: "yes_no", blocks: "step" },
  );
  insertTurn(ctx, {
    id: `turn_${runId.slice(-6)}`,
    runId,
    planner: "claude-code",
    status: "running",
    startedAt: ctx.now,
    deadline: ctx.now + 1200,
  });
  const bearer = issueRunGrant(ctx, { runId, turnId: `turn_${runId.slice(-6)}`, deadline: ctx.now + 600 });
  const orch = { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer } };
  const escalated = escalateQuestion(orch, {
    id: asked.id,
    suggested: "yes",
    reason: "needs human",
    expectRev: asked.rev,
  });
  needsInput(ctx, task.id, "Ship?");
  const spawned: string[] = [];
  const deps = { spawnRunner: (_c: unknown, tid: string) => { spawned.push(tid); return 1; } };
  const person = personCtx(ctx);

  await expect(callOp(person, "question.answer", {
    id: escalated.id,
    answer: "yes",
    expect_rev: asked.rev, // stale (pre-escalate)
  }, deps)).rejects.toMatchObject({ code: "conflict" });

  expect(readTask(ctx, task.id)?.question?.answer).toBeUndefined();
  expect(spawned).toEqual([]);
  expect(getQuestion(ctx, asked.id)?.status).toBe("open");

  const answered = await callOp(person, "question.answer", {
    id: escalated.id,
    answer: "yes",
    expect_rev: escalated.rev,
  }, deps) as { status: string; answer?: string };

  expect(answered.status).toBe("answered");
  expect(answered.answer).toBe("yes");
  expect(readTask(ctx, task.id)?.question?.answer).toBe("yes");
  expect(spawned).toEqual([task.id]);
  expect(answerMessages(ctx, task.id, "yes")).toBe(1);
  expect(strayHumanMessages(ctx, task.id, "yes")).toBe(0);

  // A second call must not add another delivery.
  await expect(callOp(person, "question.answer", {
    id: escalated.id,
    answer: "yes",
    expect_rev: escalated.rev,
  }, deps)).rejects.toBeInstanceOf(CoreError);
  expect(answerMessages(ctx, task.id, "yes")).toBe(1);
  expect(strayHumanMessages(ctx, task.id, "yes")).toBe(0);
});

test("R2-I2: when asker already has task.question.answer, question.answer records only", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setup(ctx);
  const asked = await askQuestion(
    { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id } },
    { text: "Ship?", answerType: "yes_no", blocks: "step" },
  );
  // Person answered the task while answerer was still orchestrator (record stays open).
  needsInput(ctx, task.id, "Ship?");
  updateTask(ctx, task.id, t => {
    t.question = { text: "Ship?", at: ctx.now, answer: "yes", answeredAt: ctx.now };
  });
  insertTurn(ctx, {
    id: `turn_${runId.slice(-6)}`,
    runId,
    planner: "claude-code",
    status: "running",
    startedAt: ctx.now,
    deadline: ctx.now + 1200,
  });
  const bearer = issueRunGrant(ctx, { runId, turnId: `turn_${runId.slice(-6)}`, deadline: ctx.now + 600 });
  const orch = { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer } };
  const beforeMsgs = msgStore.thread(ctx, task.id).length;
  const settled = await callOp(orch, "question.answer", {
    id: asked.id,
    answer: "yes",
    expect_rev: asked.rev,
  }, { spawnRunner: () => 1 }) as { status: string };
  expect(settled.status).toBe("answered");
  expect(msgStore.thread(ctx, task.id).length).toBe(beforeMsgs);
  expect(strayHumanMessages(ctx, task.id, "yes")).toBe(0);
  expect(readTask(ctx, task.id)?.question?.answer).toBe("yes");
});
