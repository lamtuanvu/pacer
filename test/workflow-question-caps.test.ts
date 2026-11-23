import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { addDefinition, insertRun, insertStep } from "../src/workflow/store";
import { askQuestion, MAX_OPEN_QUESTIONS_PER_ASKER } from "../src/workflow/questions";
import { refreshPromptWait } from "../src/workflow/prompt-detector";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;

test("open question caps refuse further asks; detector skips while open", async () => {
  const ctx = fakeCtx({ now: NOW });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const def: WorkflowDef = {
    id: "t/qcaps",
    version: 1,
    steps: { ask: { type: "agent", kind: "research", prompt: "A" }, done: { type: "end" } },
    edges: [{ from: "ask", to: "done" }],
    entry: "ask",
  };
  addDefinition(ctx, def, "x");
  const run = insertRun(ctx, { workflow: "t/qcaps", version: 1, repo: tmpDir(), brief: "B", title: "T" });
  const task = createTask(ctx, {
    brief: { goal: "A", repo: run.repo },
    kind: "research",
    requestedExecutor: null,
    timeoutS: 600,
  });
  const logDir = join(ctx.pacerHome, "runs", task.id, "1");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "stdout.log");
  writeFileSync(logFile, "Continue? (y/n)\n");
  updateTask(ctx, task.id, t => {
    t.state = "running";
    t.run = {
      dir: logDir, attempt: 1, executor: "codex", startedAt: NOW - 120, mode: "new",
      workdir: run.repo, logFile, agentSession: { id: "s", source: "header" },
    };
    t.progress = {
      phase: "working", lastOutputAt: NOW - 60, lastChangeAt: NOW - 60,
      files: 0, commits: 0, logBytes: 20, host: "local", updatedAt: NOW - 60,
    };
  });
  insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, taskId: task.id, status: "running" });
  const exec = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id } };
  for (let i = 0; i < MAX_OPEN_QUESTIONS_PER_ASKER; i++) {
    await askQuestion(exec, { text: `q${i}`, answerType: "text", blocks: "nothing" });
  }
  await expect(askQuestion(exec, { text: "overflow", answerType: "text", blocks: "nothing" }))
    .rejects.toMatchObject({ code: "conflict" });
  expect(refreshPromptWait(ctx, task.id)).toBeNull();
});
