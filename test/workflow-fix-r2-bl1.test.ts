import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { addDefinition, getQuestion, insertRun, insertStep } from "../src/workflow/store";
import { issueRunGrant } from "../src/workflow/run-grant";
import { insertTurn, openWakeups } from "../src/workflow/wakeups";
import { askQuestion, escalateQuestion } from "../src/workflow/questions";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";
import { readOutboxSince } from "../src/link/store";

const NOW = 1_700_000_000;

const def: WorkflowDef = {
  id: "t/r2bl1",
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

function setupExecutorStep(ctx: Ctx): { runId: string; task: TaskRecord } {
  withStrategy(ctx);
  addDefinition(ctx, def, "id: t/r2bl1\n");
  const run = insertRun(ctx, { workflow: "t/r2bl1", version: 1, repo: tmpDir(), brief: "B", title: "Q" });
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

function questionEntityEvents(ctx: Ctx, questionId: string) {
  return readOutboxSince(ctx, 0).filter(e =>
    e.envelope.type === "entity"
    && (e.envelope.data as { kind?: string; id?: string }).kind === "question"
    && (e.envelope.data as { id?: string }).id === questionId
  );
}

async function escalateThenAnswerViaOp(
  answerType: "yes_no" | "single" | "text",
  answer: string,
  options?: { value: string }[],
) {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setupExecutorStep(ctx);
  const text = answerType === "yes_no" ? "Ship?" : answerType === "single" ? "Which?" : "Notes?";
  const asked = await askQuestion(executorCtx(ctx, task.id), {
    text,
    answerType,
    blocks: "step",
    ...(options ? { options } : {}),
  });
  const orch = grantCtx(ctx, runId);
  const escalated = escalateQuestion(orch, {
    id: asked.id,
    suggested: answer,
    reason: "needs human",
    expectRev: asked.rev,
  });
  needsInputFixture(ctx, task.id, text);
  const person = { ...ctx, env: { ...ctx.env } };
  delete (person.env as { PACER_RUN_GRANT?: string }).PACER_RUN_GRANT;
  delete (person.env as { PACER_ROLE?: string }).PACER_ROLE;
  delete (person.env as { PACER_TASK_ID?: string }).PACER_TASK_ID;
  const spawned: string[] = [];
  const result = await callOp(person, "question.answer", {
    id: escalated.id,
    answer,
    expect_rev: escalated.rev,
  }, { spawnRunner: (_c, tid) => { spawned.push(tid); return 1; } }) as {
    id: string;
    status: string;
    answer?: string;
    rev: number;
  };
  return { ctx, runId, task, asked, escalated, result, spawned };
}

for (const case_ of [
  { answerType: "yes_no" as const, answer: "yes" },
  { answerType: "single" as const, answer: "postgres", options: [{ value: "postgres" }, { value: "sqlite" }] },
  { answerType: "text" as const, answer: "ship it" },
]) {
  test(`R2-BL1: note-less ${case_.answerType} via question.answer succeeds once with entity+wake`, async () => {
    const { ctx, runId, task, asked, result, spawned } = await escalateThenAnswerViaOp(
      case_.answerType,
      case_.answer,
      case_.options,
    );
    expect(result.status).toBe("answered");
    expect(result.answer).toBe(case_.answer);
    expect(getQuestion(ctx, asked.id)?.status).toBe("answered");
    expect(readTask(ctx, task.id)?.question?.answer).toBe(case_.answer);
    expect(spawned).toEqual([task.id]);
    expect(openWakeups(ctx, runId).every(w => w.ref !== asked.id)).toBe(true);
    const entities = questionEntityEvents(ctx, asked.id);
    expect(entities.some(e => (e.envelope.data as { value?: { status?: string } }).value?.status === "answered")).toBe(true);
  });
}
