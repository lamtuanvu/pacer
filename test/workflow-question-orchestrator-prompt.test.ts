import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { addDefinition, getDefinition, getRun, insertRun, insertStep, stepsOfRun } from "../src/workflow/store";
import { askQuestion, escalateQuestion } from "../src/workflow/questions";
import { buildTurnPrompt } from "../src/workflow/orchestrator";
import { insertTurn, openWakeups } from "../src/workflow/wakeups";
import { issueRunGrant } from "../src/workflow/run-grant";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";
import { findCommand } from "../src/commands";
import { main } from "../src/cli";

const NOW = 1_700_000_000;

const def: WorkflowDef = {
  id: "t/qprompt",
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

function setup(ctx: Ctx): { runId: string; task: TaskRecord } {
  withStrategy(ctx);
  addDefinition(ctx, def, "id: t/qprompt\n");
  const run = insertRun(ctx, { workflow: "t/qprompt", version: 1, repo: tmpDir(), brief: "B", title: "Q" });
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
      agentSession: { id: "sid", source: "header" },
    };
  });
  insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, taskId: task.id, status: "running" });
  return { runId: run.id, task: readTask(ctx, task.id)! };
}

test("executor question wake includes DATA question block and answer/escalate commands", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setup(ctx);
  const asked = await askQuestion(
    { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id } },
    {
      text: "Which DB?",
      answerType: "single",
      options: [{ value: "postgres" }, { value: "sqlite" }],
      recommended: "postgres",
      blocks: "step",
    },
  );
  const wakes = openWakeups(ctx, runId);
  expect(wakes.some(w => w.ref === asked.id)).toBe(true);
  const prompt = buildTurnPrompt(
    ctx,
    getRun(ctx, runId)!,
    wakes,
    getDefinition(ctx, "t/qprompt"),
    stepsOfRun(ctx, runId),
  );
  expect(prompt).toContain("pacer answer");
  expect(prompt).toContain("question escalate");
  expect(prompt).toContain(asked.id);
  expect(prompt).toContain("Which DB?");
  expect(prompt).toContain("postgres");
  expect(prompt).toContain(`"rev": ${asked.rev}`);
});

test("CLI question escalate|get|list are registered; ask accepts --artifact", async () => {
  expect(findCommand("question")).toBeDefined();
  const ctx = fakeCtx({ now: NOW });
  ctx.env.PACER_API = "inprocess";
  withStrategy(ctx);
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
  escalateQuestion(orch, {
    id: asked.id,
    suggested: "yes",
    reason: "looks fine",
    expectRev: asked.rev,
  });
  const qCmd = findCommand("question")!;
  const listed = await qCmd.run(["list", "--run", runId, "--json"], ctx);
  expect(listed.code).toBe(0);
  expect(listed.out).toContain(asked.id);
  const got = await qCmd.run(["get", asked.id, "--json"], ctx);
  expect(got.code).toBe(0);
  expect(got.out).toContain("person");

  const askResult = await main(
    ["ask", "--type", "text", "--blocks", "nothing", "--artifact", "path/to.md", "Note this"],
    { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id } },
  );
  expect(askResult.code).toBe(0);
  expect(askResult.out).toContain("path/to.md");
});
