import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";
import { createTask, readTask, taskDatabase, updateTask } from "../src/tasks/store";
import { addDefinition, getQuestion, insertRun, insertStep, listQuestions } from "../src/workflow/store";
import { issueRunGrant } from "../src/workflow/run-grant";
import { insertTurn } from "../src/workflow/wakeups";
import { askQuestion, escalateQuestion } from "../src/workflow/questions";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";

const NOW = 1_700_000_000;

const def: WorkflowDef = {
  id: "t/r2i4",
  version: 1,
  steps: {
    ask: { type: "agent", kind: "research", prompt: "Ask" },
    done: { type: "end" },
  },
  edges: [{ from: "ask", to: "done" }],
  entry: "ask",
};

function workflowTableNames(ctx: Ctx): string[] {
  return taskDatabase(ctx).query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workflow_%' ORDER BY name",
  ).all().map(r => r.name);
}

test("R2-I4: ordinary task.ask/answer never create workflow schema", async () => {
  const ctx = fakeCtx({ now: NOW });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const task = createTask(ctx, {
    brief: { goal: "g", repo: gitRepo() },
    kind: null,
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  updateTask(ctx, task.id, t => { t.state = "running"; t.executor = "codex"; });
  expect(workflowTableNames(ctx)).toEqual([]);

  const exec = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id } };
  await callOp(exec, "task.ask", { id: task.id, text: "which db?" });
  expect(workflowTableNames(ctx)).toEqual([]);

  updateTask(ctx, task.id, t => {
    t.state = "needs_input";
    t.question = { text: "which db?", at: ctx.now };
  });
  const person = { ...ctx, env: {} };
  await callOp(person, "task.answer", { id: task.id, text: "postgres" }, {
    spawnRunner: () => 1,
  });
  expect(workflowTableNames(ctx)).toEqual([]);
  expect(readTask(ctx, task.id)?.question?.answer).toBe("postgres");
});

test("R2-I4: resume failure leaves the linked question open", async () => {
  const ctx = fakeCtx({ now: NOW });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  addDefinition(ctx, def, "id: t/r2i4\n");
  const run = insertRun(ctx, { workflow: "t/r2i4", version: 1, repo: tmpDir(), brief: "B", title: "Q" });
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
  const asked = await askQuestion(
    { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id } },
    { text: "Ship?", answerType: "yes_no", blocks: "step" },
  );
  insertTurn(ctx, {
    id: `turn_${run.id.slice(-6)}`,
    runId: run.id,
    planner: "claude-code",
    status: "running",
    startedAt: ctx.now,
    deadline: ctx.now + 1200,
  });
  const bearer = issueRunGrant(ctx, {
    runId: run.id,
    turnId: `turn_${run.id.slice(-6)}`,
    deadline: ctx.now + 600,
  });
  const escalated = escalateQuestion(
    { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer } },
    { id: asked.id, suggested: "yes", reason: "need person", expectRev: asked.rev },
  );
  // Task is stopped — resume must fail; question must stay open.
  updateTask(ctx, task.id, t => {
    t.state = "stopped";
    t.question = { text: "Ship?", at: ctx.now };
  });
  const person = { ...ctx, env: {} };
  await expect(callOp(person, "task.answer", {
    id: task.id,
    text: "yes",
  }, { spawnRunner: () => 1 })).rejects.toMatchObject({ code: "conflict" });
  expect(getQuestion(ctx, escalated.id)?.status).toBe("open");
  expect(listQuestions(ctx, run.id, "open").some(q => q.id === escalated.id)).toBe(true);
});
