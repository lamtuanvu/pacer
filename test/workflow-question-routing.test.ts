import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { addDefinition, getQuestion, insertRun, insertStep, listQuestions } from "../src/workflow/store";
import { issueRunGrant } from "../src/workflow/run-grant";
import { insertTurn, openWakeups } from "../src/workflow/wakeups";
import { askQuestion, answerQuestion, escalateQuestion } from "../src/workflow/questions";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";
import * as msgStore from "../src/messaging/store";

const NOW = 1_700_000_000;

const def: WorkflowDef = {
  id: "t/qroute",
  version: 1,
  steps: {
    ask: { type: "agent", kind: "research", prompt: "Ask" },
    done: { type: "end" },
  },
  edges: [{ from: "ask", to: "done" }],
  entry: "ask",
};

function withStrategy(ctx: Ctx): Ctx {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  return ctx;
}

function executorCtx(base: Ctx, taskId: string): Ctx {
  return { ...base, env: { ...base.env, PACER_ROLE: "executor", PACER_TASK_ID: taskId } };
}

function grantCtx(base: Ctx, runId: string): { ctx: Ctx; bearer: string } {
  insertTurn(base, {
    id: `turn_${runId.slice(-6)}`,
    runId,
    planner: "claude-code",
    status: "running",
    startedAt: base.now,
    deadline: base.now + 1200,
  });
  const bearer = issueRunGrant(base, { runId, turnId: `turn_${runId.slice(-6)}`, deadline: base.now + 600 });
  return { ctx: { ...base, env: { ...base.env, PACER_RUN_GRANT: bearer } }, bearer };
}

function setupExecutorStep(ctx: Ctx): { runId: string; task: TaskRecord } {
  withStrategy(ctx);
  addDefinition(ctx, def, "id: t/qroute\n");
  const run = insertRun(ctx, { workflow: "t/qroute", version: 1, repo: tmpDir(), brief: "B", title: "Q" });
  const task = createTask(ctx, {
    brief: { goal: "Ask", repo: run.repo },
    kind: "research",
    requestedExecutor: null,
    timeoutS: 600,
  });
  updateTask(ctx, task.id, t => {
    t.state = "running";
    t.run = {
      dir: tmpDir(),
      attempt: 1,
      executor: "codex",
      startedAt: ctx.now,
      mode: "new",
      workdir: run.repo,
      logFile: "/dev/null",
      agentSession: { id: "sid-1", source: "header" },
    };
  });
  insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, taskId: task.id, status: "running" });
  return { runId: run.id, task: readTask(ctx, task.id)! };
}

function needsInputFixture(ctx: Ctx, taskId: string, text: string): void {
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

test("executor ask → orchestrator answers → executor resumes with the exact answer", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setupExecutorStep(ctx);
  const asked = await askQuestion(executorCtx(ctx, task.id), {
    text: "Which DB?",
    answerType: "single",
    options: [{ value: "postgres" }, { value: "sqlite" }],
    recommended: "postgres",
    blocks: "step",
  });
  expect(asked.answerer).toBe("orchestrator");
  expect(asked.askerTaskId).toBe(task.id);
  expect(openWakeups(ctx, runId).some(w => w.cause === "question" && w.ref === asked.id)).toBe(true);
  expect(readTask(ctx, task.id)?.question?.text).toBe("Which DB?");

  needsInputFixture(ctx, task.id, "Which DB?");
  const { ctx: orch } = grantCtx(ctx, runId);
  const spawned: string[] = [];
  const answered = await answerQuestion(orch, {
    id: asked.id,
    answer: "postgres",
    expectRev: asked.rev,
  }, { spawnRunner: (_c, tid) => { spawned.push(tid); return 1; } });
  expect(answered.status).toBe("answered");
  expect(answered.answer).toBe("postgres");
  expect(readTask(ctx, task.id)?.question?.answer).toBe("postgres");
  expect(spawned).toEqual([task.id]);
  expect(openWakeups(ctx, runId).every(w => w.ref !== asked.id)).toBe(true);
});

test("executor ask → escalate → person answers; chain records orchestrator", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setupExecutorStep(ctx);
  const asked = await askQuestion(executorCtx(ctx, task.id), {
    text: "Ship?",
    answerType: "yes_no",
    blocks: "step",
  });
  const { ctx: orch } = grantCtx(ctx, runId);
  const escalated = escalateQuestion(orch, {
    id: asked.id,
    suggested: "yes — looks ready",
    reason: "needs human sign-off",
    expectRev: asked.rev,
  });
  expect(escalated.answerer).toBe("person");
  expect(escalated.suggested).toBe("yes — looks ready");
  expect(escalated.chain).toContain("orchestrator");

  needsInputFixture(ctx, task.id, "Ship?");
  const person = { ...ctx, env: { ...ctx.env } }; // no run grant
  const answered = await answerQuestion(person, {
    id: escalated.id,
    answer: "no — wait",
    expectRev: escalated.rev,
  }, { spawnRunner: () => 1 });
  expect(answered.answer).toBe("no — wait");
  expect(getQuestion(ctx, asked.id)?.chain).toContain("orchestrator");
  expect(readTask(ctx, task.id)?.question?.answer).toBe("no — wait");
});

test("blocks: nothing leaves the task running and delivers a message", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setupExecutorStep(ctx);
  const asked = await askQuestion(executorCtx(ctx, task.id), {
    text: "FYI preference?",
    answerType: "text",
    blocks: "nothing",
  });
  expect(readTask(ctx, task.id)?.state).toBe("running");
  expect(readTask(ctx, task.id)?.question).toBeUndefined();

  const { ctx: orch } = grantCtx(ctx, runId);
  await answerQuestion(orch, {
    id: asked.id,
    answer: "prefer A",
    expectRev: asked.rev,
  });
  expect(readTask(ctx, task.id)?.state).toBe("running");
  expect(readTask(ctx, task.id)?.question).toBeUndefined();
  const pending = msgStore.pendingFor(ctx, `task:${task.id}`);
  expect(pending.some(m => m.body === "prefer A" && m.kind === "message")).toBe(true);
});

test("answer by a non-answerer is not_allowed", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setupExecutorStep(ctx);
  const asked = await askQuestion(executorCtx(ctx, task.id), {
    text: "Pick?",
    answerType: "text",
    blocks: "step",
  });
  // Person tries while answerer is still orchestrator.
  await expect(answerQuestion(ctx, {
    id: asked.id,
    answer: "x",
    expectRev: asked.rev,
  })).rejects.toMatchObject({ code: "not_allowed" } satisfies Partial<CoreError>);
  expect(listQuestions(ctx, runId, "open")).toHaveLength(1);
});
