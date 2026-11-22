import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, escalateQuestionRecord, getQuestion, getRun, listQuestions, stepsOfRun, updateRun, workflowDatabase,
} from "../src/workflow/store";
import { answerHumanStep, onTaskSettled, recordStepResult, startRun, type EngineDeps } from "../src/workflow/engine";
import { answerQuestion, escalateQuestion } from "../src/workflow/questions";
import { issueRunGrant } from "../src/workflow/run-grant";
import {
  insertTurn, needsOrchestrator, openWakeups, releaseWakeups, stepWakeRef, updateTurn, wakeCauseStillOpen,
} from "../src/workflow/wakeups";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";

const NOW = 1_700_000_000;

function fakeDeps() {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: EngineDeps["delegate"] = async (ctx, input: DelegateInput) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return readTask(ctx, prior.id) ?? prior;
    const task = createTask(ctx, {
      brief: input.brief,
      kind: input.kind ?? null,
      requestedExecutor: null,
      timeoutS: 600,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return {
    deps: {
      delegate,
      stopTask: (ctx: Ctx, id: string) => { updateTask(ctx, id, t => { t.state = "stopped"; }); },
    } satisfies EngineDeps,
  };
}

function withStrategy(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
}

/** Entry is human — used when auto stays off (default). */
const humanEntry: WorkflowDef = {
  id: "t/hq-entry",
  version: 1,
  steps: {
    route: { type: "human", decision: "auto", question: { text: "Route?", kind: "text" } },
    approve: { type: "human", decision: "must", question: { text: "Approve?", kind: "approve_revise", options: ["approve", "revise"] } },
    done: { type: "end" },
  },
  edges: [
    { from: "route", to: "approve" },
    { from: "approve", to: "done", when: "result.answer == 'approve'" },
  ],
  entry: "route",
};

/** Agent first so tests can enable auto before the human step starts. */
const agentThenHuman: WorkflowDef = {
  id: "t/hq-chain",
  version: 1,
  steps: {
    draft: { type: "agent", kind: "research", prompt: "Draft" },
    route: { type: "human", decision: "auto", question: { text: "Route?", kind: "text" } },
    approve: { type: "human", decision: "must", question: { text: "Approve?", kind: "approve_revise", options: ["approve", "revise"] } },
    done: { type: "end" },
  },
  edges: [
    { from: "draft", to: "route" },
    { from: "route", to: "approve" },
    { from: "approve", to: "done", when: "result.answer == 'approve'" },
  ],
  entry: "draft",
};

function grantFor(ctx: Ctx, runId: string): Ctx {
  insertTurn(ctx, {
    id: `turn_${runId.slice(-6)}`,
    runId,
    planner: "claude-code",
    status: "running",
    startedAt: ctx.now,
    deadline: ctx.now + 1200,
  });
  const bearer = issueRunGrant(ctx, { runId, turnId: `turn_${runId.slice(-6)}`, deadline: ctx.now + 600 });
  return { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer } };
}

async function reachAutoHuman(ctx: Ctx, deps: EngineDeps): Promise<{ runId: string }> {
  addDefinition(ctx, agentThenHuman, "src-chain");
  let run = await startRun(ctx, { workflow: "t/hq-chain", repo: tmpDir(), brief: "B" }, undefined, deps);
  run = updateRun(ctx, run.id, run.rev, { auto: true });
  const draft = stepsOfRun(ctx, run.id).find(s => s.stepId === "draft")!;
  recordStepResult(ctx, draft.taskId!, { ok: true });
  updateTask(ctx, draft.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, draft.taskId!, undefined, deps);
  return { runId: run.id };
}

test("run.answer still settles a human step and resolves its question", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  addDefinition(ctx, humanEntry, "src");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: "t/hq-entry", repo: tmpDir(), brief: "B" }, undefined, deps);
  const qs = listQuestions(ctx, run.id, "open");
  expect(qs).toHaveLength(1);
  expect(qs[0]).toMatchObject({
    askerKind: "human_step",
    stepId: "route",
    blocks: "step",
    answerer: "person",
    text: "Route?",
  });
  expect(stepsOfRun(ctx, run.id)[0]?.status).toBe("waiting");

  const answered = await answerHumanStep(ctx, run.id, "route", "left", getRun(ctx, run.id)!.rev, deps);
  expect(answered.status).toBe("waiting");
  expect(getQuestion(ctx, qs[0]!.id)?.status).toBe("answered");
  expect(getQuestion(ctx, qs[0]!.id)?.answer).toBe("left");
  const next = listQuestions(ctx, run.id, "open");
  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({ stepId: "approve", answerer: "person", askerKind: "human_step" });
});

test("auto mode off → human step question answerer is person", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  addDefinition(ctx, humanEntry, "src");
  const { deps } = fakeDeps();
  const run = await startRun(ctx, { workflow: "t/hq-entry", repo: tmpDir(), brief: "B" }, undefined, deps);
  expect(getRun(ctx, run.id)?.auto).toBeFalsy();
  expect(listQuestions(ctx, run.id, "open")[0]?.answerer).toBe("person");
});

test("auto mode on → auto human step question answerer is orchestrator; must stays person", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  const { deps } = fakeDeps();
  const { runId } = await reachAutoHuman(ctx, deps);
  const routeQ = listQuestions(ctx, runId, "open")[0]!;
  expect(routeQ).toMatchObject({ stepId: "route", answerer: "orchestrator", askerKind: "human_step" });
  expect(openWakeups(ctx, runId).some(w => w.cause === "question")).toBe(true);

  await answerHumanStep(ctx, runId, "route", "go", getRun(ctx, runId)!.rev, deps);
  const approveQ = listQuestions(ctx, runId, "open")[0]!;
  expect(approveQ.stepId).toBe("approve");
  expect(approveQ.answerer).toBe("person");
});

test("escalate auto human-step completes wakes; needsOrchestrator stays empty after turn ends", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  const { deps } = fakeDeps();
  const { runId } = await reachAutoHuman(ctx, deps);
  const routeQ = listQuestions(ctx, runId, "open")[0]!;
  expect(routeQ.answerer).toBe("orchestrator");
  const step = stepsOfRun(ctx, runId).find(s => s.stepId === "route")!;
  const ref = stepWakeRef(runId, step.stepId, step.attempt, step.branch);
  expect(openWakeups(ctx, runId).some(w => w.cause === "question" && w.ref === ref)).toBe(true);

  const orch = grantFor(ctx, runId);
  const turnId = `turn_${runId.slice(-6)}`;
  const escalated = escalateQuestion(orch, {
    id: routeQ.id,
    suggested: "left",
    reason: "needs a person",
    expectRev: routeQ.rev,
  });
  expect(escalated.answerer).toBe("person");
  expect(openWakeups(ctx, runId).every(w => w.ref !== ref && w.ref !== routeQ.id)).toBe(true);
  expect(wakeCauseStillOpen(ctx, runId, "question", ref)).toBe(false);
  expect(needsOrchestrator(ctx).filter(n => n.runId === runId && n.cause === "question")).toEqual([]);

  // End the orchestrator turn the way settle does: release uncompleted claims.
  updateTurn(ctx, turnId, { status: "done", endedAt: ctx.now });
  releaseWakeups(ctx, turnId);
  expect(openWakeups(ctx, runId).filter(w => w.cause === "question")).toEqual([]);
  expect(needsOrchestrator(ctx).filter(n => n.runId === runId && n.cause === "question")).toEqual([]);
  expect(wakeCauseStillOpen(ctx, runId, "question", ref)).toBe(false);
});

test("must question refuses an orchestrator answer even after an escalate-like attempt", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  const { deps } = fakeDeps();
  const { runId } = await reachAutoHuman(ctx, deps);
  await answerHumanStep(ctx, runId, "route", "go", getRun(ctx, runId)!.rev, deps);
  const mustQ = listQuestions(ctx, runId, "open")[0]!;
  expect(mustQ.answerer).toBe("person");

  // escalateQuestionRecord flips answerer to person; simulate a bad write to orchestrator.
  escalateQuestionRecord(ctx, mustQ.id, {
    suggested: "approve",
    expectRev: mustQ.rev,
    by: "orchestrator",
  });
  workflowDatabase(ctx).query(
    "UPDATE workflow_questions SET answerer = 'orchestrator', rev = rev + 1 WHERE id = ?",
  ).run(mustQ.id);
  const bad = getQuestion(ctx, mustQ.id)!;
  expect(bad.answerer).toBe("orchestrator");

  const orch = grantFor(ctx, runId);
  await expect(answerQuestion(orch, {
    id: bad.id,
    answer: "approve",
    expectRev: bad.rev,
  })).rejects.toMatchObject({ code: "not_allowed" } satisfies Partial<CoreError>);
  expect(getQuestion(ctx, mustQ.id)?.status).toBe("open");

  expect(() => escalateQuestion(orch, {
    id: getQuestion(ctx, mustQ.id)!.id,
    suggested: "approve",
    reason: "please",
    expectRev: getQuestion(ctx, mustQ.id)!.rev,
  })).toThrow(/must|not_allowed|cannot escalate/i);

  const done = await answerHumanStep(ctx, runId, "approve", "approve", getRun(ctx, runId)!.rev, deps);
  expect(done.status).toBe("done");
});
