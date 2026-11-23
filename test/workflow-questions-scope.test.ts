import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp, OPS } from "../src/api/ops";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import {
  insertQuestion, insertRun, workflowDatabase,
} from "../src/workflow/store";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";

/** Ordinary task.ask / task.answer keep working when the home also has runs and open run questions. */
function homeWithRunsAndQuestions() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  workflowDatabase(ctx);
  const run = insertRun(ctx, {
    workflow: "t/scope",
    version: 1,
    repo: tmpDir(),
    brief: "B",
    title: "Scope",
  });
  insertQuestion(ctx, {
    runId: run.id,
    stepId: "ask",
    attempt: 1,
    askerKind: "orchestrator",
    text: "Run question?",
    answerType: "text",
    blocks: "nothing",
    answerer: "person",
  });
  const task = createTask(ctx, {
    brief: { goal: "g", repo: gitRepo() },
    kind: null,
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  updateTask(ctx, task.id, t => { t.state = "running"; t.executor = "codex"; });
  ctx.env = {
    PACER_PORT: process.env.PACER_PORT,
    PACER_ROLE: "executor",
    PACER_TASK_ID: task.id,
  };
  return { ctx, task, run };
}

test("ordinary task.ask records verbatim when run questions exist", async () => {
  const { ctx, task } = homeWithRunsAndQuestions();
  const text = "which db? $(rm -rf ~)\nsecond line";
  await OPS["task.ask"].handler(ctx, { id: task.id, text }, {});
  expect(readTask(ctx, task.id)?.question).toEqual({ text, at: ctx.now });
  await expect(OPS["task.ask"].handler(ctx, { id: task.id, text: "again" }, {}))
    .rejects.toThrow(/already asked/);
});

test("ordinary task.answer still resumes needs_input with open run questions present", async () => {
  const { ctx, task } = homeWithRunsAndQuestions();
  const text = "which?";
  updateTask(ctx, task.id, t => {
    t.state = "needs_input";
    t.executor = "codex";
    t.question = { text, at: ctx.now - 1 };
  });
  const spawned: string[] = [];
  const deps = { spawnRunner: (_: unknown, id: string) => { spawned.push(id); return 1; } };
  const person = { ...ctx, env: {} };
  const result = await callOp(person, "task.answer", { id: task.id, text: "postgres" }, deps) as {
    task: { question?: { answer?: string } };
    retry: { id: string };
  };
  expect(result.task.question).toMatchObject({ text, answer: "postgres" });
  expect(spawned).toEqual([result.retry.id]);
});

test("question ops exist and are distinct from task.ask", () => {
  expect(OPS["question.ask"]).toBeDefined();
  expect(OPS["question.answer"]).toBeDefined();
  expect(OPS["question.escalate"]).toBeDefined();
  expect(OPS["question.get"]).toBeDefined();
  expect(OPS["question.list"]).toBeDefined();
  expect(OPS["question.convert_prompt"]).toBeDefined();
  expect(OPS["task.ask"]).toBeDefined();
  expect(OPS["task.answer"]).toBeDefined();
});
