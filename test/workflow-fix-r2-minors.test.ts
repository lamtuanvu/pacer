import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import { createTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, getQuestion, getRun, listQuestions, stepsOfRun, updateRun,
} from "../src/workflow/store";
import { onTaskSettled, recordStepResult, startRun, type EngineDeps } from "../src/workflow/engine";
import { answerQuestion, escalateQuestion } from "../src/workflow/questions";
import { issueRunGrant } from "../src/workflow/run-grant";
import { insertTurn, openWakeups, stepWakeRef } from "../src/workflow/wakeups";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";

const NOW = 1_700_000_000;

function withStrategy(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
}

function fakeDeps(): EngineDeps {
  const byRequest = new Map<string, TaskRecord>();
  return {
    delegate: async (ctx, input: DelegateInput) => {
      const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
      if (prior) return prior;
      const task = createTask(ctx, {
        brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600,
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
      if (input.requestId) byRequest.set(input.requestId, task);
      return task;
    },
    stopTask: (ctx, id) => { updateTask(ctx, id, t => { t.state = "stopped"; }); },
  };
}

const agentThenHuman: WorkflowDef = {
  id: "t/r2min",
  version: 1,
  steps: {
    draft: { type: "agent", kind: "research", prompt: "Draft" },
    route: { type: "human", decision: "auto", question: { text: "Route?", kind: "text" } },
    done: { type: "end" },
  },
  edges: [{ from: "draft", to: "route" }, { from: "route", to: "done" }],
  entry: "draft",
};

async function startAutoHuman(ctx: Ctx) {
  withStrategy(ctx);
  const deps = fakeDeps();
  addDefinition(ctx, agentThenHuman, "x");
  let run = await startRun(ctx, { workflow: "t/r2min", repo: tmpDir(), brief: "B" }, undefined, deps);
  run = updateRun(ctx, run.id, run.rev, { auto: true });
  const draft = stepsOfRun(ctx, run.id).find(s => s.stepId === "draft")!;
  recordStepResult(ctx, draft.taskId!, { ok: true });
  updateTask(ctx, draft.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, draft.taskId!, undefined, deps);
  const q = listQuestions(ctx, run.id, "open")[0]!;
  return { run, q, deps };
}

test("M-2: orchestrator cannot answer a human_step question after escalate to person", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { run, q } = await startAutoHuman(ctx);
  expect(q.answerer).toBe("orchestrator");
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
  const orch = { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer } };
  const escalated = escalateQuestion(orch, {
    id: q.id,
    suggested: "go",
    reason: "need person",
    expectRev: q.rev,
  });
  expect(escalated.answerer).toBe("person");
  await expect(answerQuestion(orch, {
    id: escalated.id,
    answer: "go",
    expectRev: escalated.rev,
  })).rejects.toMatchObject({ code: "not_allowed" });
  expect(getQuestion(ctx, q.id)?.status).toBe("open");
});

test("M-3: flipping auto off completes the human-step wake", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { run, q } = await startAutoHuman(ctx);
  const ref = stepWakeRef(run.id, q.stepId, q.attempt, q.branch);
  expect(openWakeups(ctx, run.id).some(w => w.ref === ref || w.ref === q.id)).toBe(true);
  ctx.env.PACER_API = "inprocess";
  await callOp(ctx, "run.set_auto", { id: run.id, auto: false, expect_rev: getRun(ctx, run.id)!.rev });
  expect(getQuestion(ctx, q.id)?.answerer).toBe("person");
  expect(openWakeups(ctx, run.id).every(w => w.ref !== ref && w.ref !== q.id)).toBe(true);
});
