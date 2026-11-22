import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { addDefinition, getQuestion, insertRun, insertStep } from "../src/workflow/store";
import { issueRunGrant } from "../src/workflow/run-grant";
import { insertTurn } from "../src/workflow/wakeups";
import { askQuestion, answerQuestion } from "../src/workflow/questions";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";

const NOW = 1_700_000_000;

const def: WorkflowDef = {
  id: "t/qbounds",
  version: 1,
  steps: {
    ask: { type: "agent", kind: "research", prompt: "Ask" },
    done: { type: "end" },
  },
  edges: [{ from: "ask", to: "done" }],
  entry: "ask",
};

function withStrategy(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
}

function executorCtx(base: Ctx, taskId: string): Ctx {
  return { ...base, env: { ...base.env, PACER_ROLE: "executor", PACER_TASK_ID: taskId } };
}

function grantCtx(base: Ctx, runId: string): Ctx {
  insertTurn(base, {
    id: `turn_${runId.slice(-6)}`,
    runId,
    planner: "claude-code",
    status: "running",
    startedAt: base.now,
    deadline: base.now + 1200,
  });
  const bearer = issueRunGrant(base, { runId, turnId: `turn_${runId.slice(-6)}`, deadline: base.now + 600 });
  return { ...base, env: { ...base.env, PACER_RUN_GRANT: bearer } };
}

function setup(ctx: Ctx): { runId: string; task: TaskRecord } {
  withStrategy(ctx);
  addDefinition(ctx, def, "id: t/qbounds\n");
  const run = insertRun(ctx, { workflow: "t/qbounds", version: 1, repo: tmpDir(), brief: "B", title: "Q" });
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

test("answer over 2000 chars is rejected before the record is written", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setup(ctx);
  const asked = await askQuestion(executorCtx(ctx, task.id), {
    text: "Long?",
    answerType: "text",
    blocks: "step",
  });
  updateTask(ctx, task.id, t => {
    t.state = "needs_input";
    t.question = { text: "Long?", at: ctx.now };
    t.attempts = [{
      executor: "codex", model: null, startedAt: ctx.now - 1, endedAt: ctx.now,
      exitCode: 0, timedOut: false, limitHit: false, log: "",
    }];
    t.result = {
      status: "needs_input", executor: "codex", model: null, files: "", report: "waiting", backend: "direct",
    };
  });
  const orch = grantCtx(ctx, runId);
  await expect(answerQuestion(orch, {
    id: asked.id,
    answer: "x".repeat(2001),
    expectRev: asked.rev,
  })).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<CoreError>);
  expect(getQuestion(ctx, asked.id)?.status).toBe("open");
});

test("yes_no rejects answers outside yes/no", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setup(ctx);
  const asked = await askQuestion(executorCtx(ctx, task.id), {
    text: "Ship?",
    answerType: "yes_no",
    blocks: "step",
  });
  const orch = grantCtx(ctx, runId);
  await expect(answerQuestion(orch, {
    id: asked.id,
    answer: "maybe",
    expectRev: asked.rev,
  })).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<CoreError>);
  expect(getQuestion(ctx, asked.id)?.status).toBe("open");
});

test("single answer must be one of the options", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setup(ctx);
  const asked = await askQuestion(executorCtx(ctx, task.id), {
    text: "Pick?",
    answerType: "single",
    options: [{ value: "a" }, { value: "b" }],
    blocks: "step",
  });
  const orch = grantCtx(ctx, runId);
  await expect(answerQuestion(orch, {
    id: asked.id,
    answer: "c",
    expectRev: asked.rev,
  })).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<CoreError>);
  expect(getQuestion(ctx, asked.id)?.status).toBe("open");
});

test("asker not yet needs_input keeps the question open (retryable)", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setup(ctx);
  const asked = await askQuestion(executorCtx(ctx, task.id), {
    text: "Ready?",
    answerType: "text",
    blocks: "step",
  });
  // task.question is set by ask, but state is still running (process exiting).
  expect(readTask(ctx, task.id)?.state).toBe("running");
  expect(readTask(ctx, task.id)?.question?.answer).toBeUndefined();
  const orch = grantCtx(ctx, runId);
  await expect(answerQuestion(orch, {
    id: asked.id,
    answer: "go",
    expectRev: asked.rev,
  }, { spawnRunner: () => 1 })).rejects.toMatchObject({ code: "conflict" } satisfies Partial<CoreError>);
  expect(getQuestion(ctx, asked.id)?.status).toBe("open");
});

test("ask text aligns with core ask bound (1000)", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { task } = setup(ctx);
  await expect(askQuestion(executorCtx(ctx, task.id), {
    text: "x".repeat(1001),
    answerType: "text",
    blocks: "nothing",
  })).rejects.toThrow();
});
