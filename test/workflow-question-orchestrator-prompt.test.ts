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

test("orchestrator/run-grant CLI allows answer and question escalate (turn prompt commands)", async () => {
  // Live Q1: turn prompt tells the orchestrator to run `pacer answer q_…` / `pacer question escalate`,
  // but the PACER_ROLE=orchestrator allow-list refused those commands before the op ran.
  const ctx = fakeCtx({ now: NOW });
  ctx.env.PACER_API = "inprocess";
  withStrategy(ctx);
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
  updateTask(ctx, task.id, t => { t.state = "needs_input"; });
  insertTurn(ctx, {
    id: `turn_${runId.slice(-6)}`,
    runId,
    planner: "claude-code",
    status: "running",
    startedAt: ctx.now,
    deadline: ctx.now + 1200,
  });
  const bearer = issueRunGrant(ctx, { runId, turnId: `turn_${runId.slice(-6)}`, deadline: ctx.now + 600 });
  const orchEnv: Record<string, string | undefined> = {
    ...ctx.env,
    PACER_ROLE: "orchestrator",
    PACER_RUN_GRANT: bearer,
    PACER_API: "inprocess",
  };
  delete orchEnv.PACER_PORT;
  const orchCtx = { ...ctx, env: orchEnv };

  const { cliDeps } = await import("../src/cli");
  const prev = cliDeps.spawnRunner;
  try {
    cliDeps.spawnRunner = () => 1;
    const answered = await main(["answer", asked.id, "postgres", "--expect-rev", String(asked.rev)], orchCtx);
    expect(answered.err).not.toMatch(/orchestrator role only allows/);
    expect(answered.code).toBe(0);
  } finally {
    cliDeps.spawnRunner = prev;
  }

  // Separate open question for escalate (blocks:nothing so it does not require needs_input).
  updateTask(ctx, task.id, t => { t.state = "running"; delete t.question; });
  const toEscalate = await askQuestion(
    { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id } },
    { text: "FYI?", answerType: "text", blocks: "nothing" },
  );
  const escalateCli = await main(
    ["question", "escalate", toEscalate.id, "--suggested", "later", "--reason", "needs human", "--expect-rev", String(toEscalate.rev)],
    orchCtx,
  );
  // Allow-list must not refuse (live Q1 failure mode). Functional escalate uses the grant API path.
  expect(escalateCli.err).not.toMatch(/orchestrator role only allows/);
  const escalated = escalateQuestion(orchCtx, {
    id: toEscalate.id,
    suggested: "later",
    reason: "needs human",
    expectRev: toEscalate.rev,
  });
  expect(escalated.answerer).toBe("person");
});

test("orchestrator CLI ask requires --step and records a person-facing question", async () => {
  // Live Q4: api call question.ask fails (prg_ cannot GET /v3/hello); structured ask must carry --step.
  const ctx = fakeCtx({ now: NOW });
  ctx.env.PACER_API = "inprocess";
  withStrategy(ctx);
  const { runId } = setup(ctx);
  insertTurn(ctx, {
    id: `turn_${runId.slice(-6)}ask`,
    runId,
    planner: "claude-code",
    status: "running",
    startedAt: ctx.now,
    deadline: ctx.now + 1200,
  });
  const bearer = issueRunGrant(ctx, { runId, turnId: `turn_${runId.slice(-6)}ask`, deadline: ctx.now + 600 });
  const orchEnv: Record<string, string | undefined> = {
    ...ctx.env,
    PACER_ROLE: "orchestrator",
    PACER_RUN_GRANT: bearer,
    PACER_API: "inprocess",
  };
  delete orchEnv.PACER_PORT;
  const orchCtx = { ...ctx, env: orchEnv };

  const missing = await main(
    ["ask", "--type", "yes_no", "--blocks", "step", "Which approach?"],
    orchCtx,
  );
  expect(missing.code).toBe(2);
  expect(missing.err).toMatch(/stepId is required/i);

  const asked = await main(
    ["ask", "--type", "yes_no", "--blocks", "step", "--step", "ask", "--attempt", "1", "Which approach?"],
    orchCtx,
  );
  expect(asked.code).toBe(0);
  const body = JSON.parse(asked.out);
  expect(body.askerKind).toBe("orchestrator");
  expect(body.answerer).toBe("person");
  expect(body.stepId).toBe("ask");
  expect(body.text).toBe("Which approach?");
});
