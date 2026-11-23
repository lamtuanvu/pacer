import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import { createTask, updateTask } from "../src/tasks/store";
import {
  addDefinition, getQuestion, insertRun, insertStep, listOpenPersonQuestions, listQuestions,
} from "../src/workflow/store";
import { askQuestion, answerQuestion, escalateQuestion } from "../src/workflow/questions";
import { stopRun, type EngineDeps } from "../src/workflow/engine";
import { insertTurn } from "../src/workflow/wakeups";
import { issueRunGrant } from "../src/workflow/run-grant";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import { createTask as create, readTask } from "../src/tasks/store";

const NOW = 1_700_000_000;

const def: WorkflowDef = {
  id: "t/qwd",
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

function deps(): EngineDeps {
  const byRequest = new Map<string, TaskRecord>();
  return {
    delegate: async (ctx, input: DelegateInput) => {
      const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
      if (prior) return readTask(ctx, prior.id) ?? prior;
      const task = create(ctx, {
        brief: input.brief,
        kind: input.kind ?? null,
        requestedExecutor: null,
        timeoutS: 600,
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
      if (input.requestId) byRequest.set(input.requestId, task);
      return task;
    },
    stopTask: (ctx, id) => { updateTask(ctx, id, t => { t.state = "stopped"; }); },
  };
}

test("stopRun withdraws open questions; answer/escalate on terminal run refused; list hides them", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  addDefinition(ctx, def, "x");
  const run = insertRun(ctx, { workflow: "t/qwd", version: 1, repo: tmpDir(), brief: "B", title: "T" });
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
    runId: run.id, turnId: `turn_${run.id.slice(-6)}`, deadline: ctx.now + 600,
  });
  escalateQuestion(
    { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer } },
    { id: asked.id, suggested: "yes", reason: "please", expectRev: asked.rev },
  );
  expect(listOpenPersonQuestions(ctx).some(q => q.id === asked.id)).toBe(true);

  await stopRun(ctx, run.id, run.rev, deps());
  expect(getQuestion(ctx, asked.id)?.status).toBe("withdrawn");
  expect(listOpenPersonQuestions(ctx).some(q => q.id === asked.id)).toBe(false);
  expect(listQuestions(ctx, run.id, "open")).toHaveLength(0);

  await expect(answerQuestion(ctx, {
    id: asked.id,
    answer: "yes",
    expectRev: getQuestion(ctx, asked.id)!.rev,
  })).rejects.toMatchObject({ code: "conflict" } satisfies Partial<CoreError>);
});
