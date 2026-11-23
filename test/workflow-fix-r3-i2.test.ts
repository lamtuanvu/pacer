// Round-3 I-2: run.decide must refuse after escalate to person.
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
import { escalateQuestion } from "../src/workflow/questions";
import { issueRunGrant } from "../src/workflow/run-grant";
import { insertTurn } from "../src/workflow/wakeups";
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
  id: "t/r3i2",
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
  let run = await startRun(ctx, { workflow: "t/r3i2", repo: tmpDir(), brief: "B" }, undefined, deps);
  run = updateRun(ctx, run.id, run.rev, { auto: true });
  const draft = stepsOfRun(ctx, run.id).find(s => s.stepId === "draft")!;
  recordStepResult(ctx, draft.taskId!, { ok: true });
  updateTask(ctx, draft.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, draft.taskId!, undefined, deps);
  const q = listQuestions(ctx, run.id, "open")[0]!;
  return { run, q, deps };
}

function orchCtx(ctx: Ctx, runId: string): Ctx {
  insertTurn(ctx, {
    id: `turn_${runId.slice(-6)}`,
    runId,
    planner: "claude-code",
    status: "running",
    startedAt: ctx.now,
    deadline: ctx.now + 1200,
  });
  const bearer = issueRunGrant(ctx, {
    runId,
    turnId: `turn_${runId.slice(-6)}`,
    deadline: ctx.now + 600,
  });
  return { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer } };
}

test("I-2: escalate then run.decide is refused; never-escalated still works", async () => {
  const ctx = fakeCtx({ now: NOW });
  const { run, q } = await startAutoHuman(ctx);
  expect(q.answerer).toBe("orchestrator");
  const orch = orchCtx(ctx, run.id);

  const escalated = escalateQuestion(orch, {
    id: q.id,
    suggested: "go",
    reason: "need person",
    expectRev: q.rev,
  });
  expect(escalated.answerer).toBe("person");

  await expect(callOp(orch, "run.decide", {
    id: run.id,
    step: "route",
    choice: "go",
    reason: "orchestrator override",
  })).rejects.toMatchObject({ code: "not_allowed" });
  expect(getQuestion(ctx, q.id)?.status).toBe("open");
  expect(getRun(ctx, run.id)?.status).not.toBe("done");

  // Control: without escalate, run.decide still answers an auto human step.
  const ctx2 = fakeCtx({ now: NOW + 10 });
  const started2 = await startAutoHuman(ctx2);
  const orch2 = orchCtx(ctx2, started2.run.id);
  expect(started2.q.answerer).toBe("orchestrator");
  const updated = await callOp(orch2, "run.decide", {
    id: started2.run.id,
    step: "route",
    choice: "ship",
    reason: "auto path",
  }) as { status: string };
  expect(getQuestion(ctx2, started2.q.id)?.status).toBe("answered");
  expect(["running", "waiting", "done"]).toContain(updated.status);
});
