import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { addDefinition, getQuestion, insertRun, insertStep } from "../src/workflow/store";
import { askQuestion, escalateQuestion, questionEntityValue } from "../src/workflow/questions";
import { insertTurn } from "../src/workflow/wakeups";
import { issueRunGrant } from "../src/workflow/run-grant";
import { parseOutboxEvent } from "../src/link/envelope";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;

test("envelope accepts question entity events; value is redacted", async () => {
  const sample = parseOutboxEvent({
    type: "entity",
    data: {
      kind: "question",
      id: "q_testhash12",
      value: { id: "q_testhash12", runId: "run_x", status: "open", blocks: "step" },
    },
  });
  expect(sample).toMatchObject({ type: "entity", data: { kind: "question", id: "q_testhash12" } });

  const ctx = fakeCtx({ now: NOW });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const def: WorkflowDef = {
    id: "t/qent",
    version: 1,
    steps: { ask: { type: "agent", kind: "research", prompt: "A" }, done: { type: "end" } },
    edges: [{ from: "ask", to: "done" }],
    entry: "ask",
  };
  addDefinition(ctx, def, "x");
  const run = insertRun(ctx, { workflow: "t/qent", version: 1, repo: tmpDir(), brief: "B", title: "T" });
  const task = createTask(ctx, {
    brief: { goal: "A", repo: run.repo },
    kind: "research",
    requestedExecutor: null,
    timeoutS: 600,
  });
  updateTask(ctx, task.id, t => {
    t.state = "running";
    t.run = {
      dir: tmpDir(), attempt: 1, executor: "codex", startedAt: ctx.now, mode: "new",
      workdir: run.repo, logFile: "/dev/null", agentSession: { id: "s", source: "header" },
    };
  });
  insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, taskId: task.id, status: "running" });

  const asked = await askQuestion(
    { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id } },
    { text: "Pick?", answerType: "yes_no", blocks: "step" },
  );
  const value = questionEntityValue(asked);
  expect(value).toEqual({
    id: asked.id,
    runId: asked.runId,
    status: "open",
    blocks: "step",
  });
  expect("text" in value).toBe(false);
  expect("answer" in value).toBe(false);

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
  escalateQuestion(
    { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer } },
    { id: asked.id, suggested: "yes — secret", reason: "need person", expectRev: asked.rev },
  );
  expect(questionEntityValue(getQuestion(ctx, asked.id)!)).toMatchObject({
    id: asked.id,
    status: "open",
    blocks: "step",
  });
  expect("suggested" in questionEntityValue(getQuestion(ctx, asked.id)!)).toBe(false);
});
