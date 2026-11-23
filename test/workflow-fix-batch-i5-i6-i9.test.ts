import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, getQuestion, getRun, listOpenPersonQuestions, listQuestions, stepsOfRun, updateRun,
} from "../src/workflow/store";
import { onTaskSettled, recordStepResult, startRun, type EngineDeps } from "../src/workflow/engine";
import { callOp } from "../src/api/ops";
import { sortItems } from "../src/attention/rules";
import type { AttentionItem } from "../src/attention/types";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";
import { askQuestion } from "../src/workflow/questions";
import { answer as answerTask } from "../src/core/tasks";

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
      if (prior) return readTask(ctx, prior.id) ?? prior;
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
  id: "t/i5",
  version: 1,
  steps: {
    draft: { type: "agent", kind: "research", prompt: "Draft" },
    route: { type: "human", decision: "auto", question: { text: "Route?", kind: "text" } },
    done: { type: "end" },
  },
  edges: [{ from: "draft", to: "route" }, { from: "route", to: "done" }],
  entry: "draft",
};

test("I5: turning auto off flips open human-step answerer to person", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  const deps = fakeDeps();
  addDefinition(ctx, agentThenHuman, "x");
  let run = await startRun(ctx, { workflow: "t/i5", repo: tmpDir(), brief: "B" }, undefined, deps);
  run = updateRun(ctx, run.id, run.rev, { auto: true });
  const draft = stepsOfRun(ctx, run.id).find(s => s.stepId === "draft")!;
  recordStepResult(ctx, draft.taskId!, { ok: true });
  updateTask(ctx, draft.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, draft.taskId!, undefined, deps);
  const q = listQuestions(ctx, run.id, "open")[0]!;
  expect(q.answerer).toBe("orchestrator");
  ctx.env.PACER_API = "inprocess";
  await callOp(ctx, "run.set_auto", { id: run.id, auto: false, expect_rev: getRun(ctx, run.id)!.rev });
  expect(getQuestion(ctx, q.id)?.answerer).toBe("person");
  expect(listOpenPersonQuestions(ctx).some(row => row.id === q.id)).toBe(true);
});

test("I6: task.answer on a step task resolves the linked open person question", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  const def: WorkflowDef = {
    id: "t/i6",
    version: 1,
    steps: { ask: { type: "agent", kind: "research", prompt: "A" }, done: { type: "end" } },
    edges: [{ from: "ask", to: "done" }],
    entry: "ask",
  };
  addDefinition(ctx, def, "x");
  const { insertRun, insertStep } = await import("../src/workflow/store");
  const run = insertRun(ctx, { workflow: "t/i6", version: 1, repo: tmpDir(), brief: "B", title: "T" });
  const task = createTask(ctx, {
    brief: { goal: "A", repo: run.repo }, kind: "research", requestedExecutor: null, timeoutS: 600,
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
  updateTask(ctx, task.id, t => {
    t.state = "needs_input";
    t.question = { text: "Ship?", at: ctx.now };
    t.attempts = [{
      executor: "codex", model: null, startedAt: ctx.now - 1, endedAt: ctx.now,
      exitCode: 0, timedOut: false, limitHit: false, log: "",
    }];
    t.result = {
      status: "needs_input", executor: "codex", model: null, files: "", report: "waiting", backend: "direct",
    };
  });
  // Escalate so the person can answer via task.answer.
  const { escalateQuestionRecord } = await import("../src/workflow/store");
  escalateQuestionRecord(ctx, asked.id, { suggested: "yes", expectRev: asked.rev, by: "orchestrator" });
  await answerTask(ctx, task.id, "yes", {}, { spawnRunner: () => 1 });
  expect(getQuestion(ctx, asked.id)?.status).toBe("answered");
});

test("I9: attention sort is a total order across mixed run and ordinary items", () => {
  const items: AttentionItem[] = [
    {
      id: "question:run_a", kind: "question", severity: "blocked", repo: null,
      title: "A", detail: "d", raisedAt: 10, since: 10, actions: [], notify: "important",
      unblocks: "run", run: { id: "run_a", letter: "A", title: "A", priority: "normal" },
    },
    {
      id: "question:run_b", kind: "question", severity: "blocked", repo: null,
      title: "B", detail: "d", raisedAt: 1, since: 1, actions: [], notify: "important",
      unblocks: "branch", run: { id: "run_b", letter: "B", title: "B", priority: "normal" },
    },
    {
      id: "question:t-ordinary", kind: "question", severity: "blocked", repo: null,
      title: "O", detail: "d", raisedAt: 5, since: 5, actions: [], notify: "important",
      taskId: "t-ordinary",
    },
  ];
  const sorted = sortItems([...items]);
  expect(sorted.map(i => i.id)).toEqual([
    "question:run_a",
    "question:run_b",
    "question:t-ordinary",
  ]);
  // Antisymmetry: sorting twice is stable / equal order.
  expect(sortItems([...sorted]).map(i => i.id)).toEqual(sorted.map(i => i.id));
});
