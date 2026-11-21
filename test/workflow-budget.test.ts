// Phase 2 Task 8: per-run orchestrator and message budgets (D3).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { callOp, type OpDeps } from "../src/api/ops";
import { CoreError } from "../src/core/errors";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, getRun, insertRun, insertStep, stepsOfRun, stepByTask, updateRun, workflowDatabase, type RunRow,
} from "../src/workflow/store";
import { onTaskSettled } from "../src/workflow/engine";
import { addWakeup } from "../src/workflow/wakeups";
import { startTurn, settleTurn, getBudgetAttention, type OrchestratorDeps } from "../src/workflow/orchestrator";
import {
  COALESCE_WINDOW_S, DEFAULT_BUDGET, countOrchestratorTurn, countMessageTurn, isBudgetBlocked,
  parseBudget, parseSpent, budgetAllowsTurn, budgetAllowsMessage, serializeBudget, serializeSpent,
} from "../src/workflow/budget";
import { deriveWorkflowAttention } from "../src/workflow/attention";
import { sendMessage } from "../src/messaging/send";
import { startTurnIfIdle } from "../src/messaging/turns";
import * as msgStore from "../src/messaging/store";

const NOW = 1_700_000_000;

const CHAIN = `
id: t/budget
version: 1
policy:
  budget: { orchestrator_turns: 5, message_turns: 3 }
steps:
  one: { type: agent, kind: research, prompt: "One" }
  approve: { type: human, decision: must, question: { text: "Ok?", kind: approve_revise } }
  two: { type: agent, kind: research, prompt: "Two" }
  done: { type: end }
edges:
  - [one, approve]
  - [approve, two]
  - [two, done]
`;

function stubDeps(): OpDeps {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: OpDeps["delegate"] = async (ctx, input: DelegateInput) => {
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
  return { delegate };
}

function writePlanner(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

function orchDeps(_ctx: Ctx): OrchestratorDeps {
  return {
    spawn: (() => 1) as OrchestratorDeps["spawn"],
    plannerEligible: () => true,
  };
}

const fail = async (p: Promise<unknown>): Promise<CoreError> => {
  try { await p; return null as unknown as CoreError; }
  catch (e) { return e as CoreError; }
};

describe("per-run orchestrator and message budgets", () => {
  test("defaults and policy.budget parsing", () => {
    expect(DEFAULT_BUDGET).toEqual({ orchestratorTurns: 60, messageTurns: 20 });
    expect(parseBudget(JSON.stringify({ orchestrator_turns: 5, message_turns: 3 }))).toEqual({
      orchestratorTurns: 5, messageTurns: 3,
    });
    expect(parseSpent(undefined)).toEqual({ orchestratorTurns: 0, messageTurns: 0 });
  });

  test("counting orchestrator turns; 80% raises attention; 100% blocks new turns", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    const run = await callOp(ctx, "run.start", {
      workflow: "t/budget", repo: tmpDir(), brief: "Do X",
    }, stubDeps()) as RunRow;
    // Policy budget applied at start.
    expect(parseBudget(run.budget)).toEqual({ orchestratorTurns: 5, messageTurns: 3 });

    // Spend 4 of 5 (80%).
    for (let i = 0; i < 4; i++) countOrchestratorTurn(ctx, run.id);
    const at80 = getBudgetAttention(ctx, run.id);
    expect(at80?.title).toMatch(/80%/i);

    // 5th turn still allowed; then spent.
    expect(budgetAllowsTurn(ctx, getRun(ctx, run.id)!)).toBe(true);
    countOrchestratorTurn(ctx, run.id);
    expect(budgetAllowsTurn(ctx, getRun(ctx, run.id)!)).toBe(false);
    const blocked = getRun(ctx, run.id)!;
    expect(blocked.orchestratorState).toBe("blocked");
    expect(blocked.reason).toMatch(/turn budget spent/i);
    const ask = getBudgetAttention(ctx, run.id);
    expect(ask?.severity).toBe("decide");
    expect(ask?.detail).toMatch(/raise the budget or stop/i);

    // Wake-up present but startTurn returns null.
    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_settled", ref: "one#1", createdAt: NOW,
    });
    expect(await startTurn(ctx, run.id, orchDeps(ctx))).toBeNull();
  });

  test("mechanical edges still advance and run.answer works while budget blocked", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    let run = await callOp(ctx, "run.start", {
      workflow: "t/budget", repo: tmpDir(), brief: "Do X",
    }, stubDeps()) as RunRow;
    // Exhaust budget.
    for (let i = 0; i < 5; i++) countOrchestratorTurn(ctx, run.id);
    // Settle agent step → human waits (mechanical advance).
    const step = stepsOfRun(ctx, run.id)[0]!;
    await callOp({ ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: step.taskId! } },
      "step.result", { result: { ok: true } });
    updateTask(ctx, step.taskId!, t => { t.state = "done"; });
    await onTaskSettled(ctx, step.taskId!);
    run = getRun(ctx, run.id)!;
    expect(run.status).toBe("waiting");
    expect(stepsOfRun(ctx, run.id).find(s => s.stepId === "approve")!.status).toBe("waiting");
    // Person answers must step while budget blocked.
    const answered = await callOp(ctx, "run.answer", {
      id: run.id, step: "approve", answer: "approve", expect_rev: run.rev,
    }) as RunRow;
    expect(stepsOfRun(ctx, answered.id).find(s => s.stepId === "approve")!.result).toEqual({ answer: "approve" });
    // Next agent step started mechanically.
    expect(stepsOfRun(ctx, answered.id).some(s => s.stepId === "two" && s.status === "running")).toBe(true);
  });

  test("raising the budget lets turns start again; stop stops the run", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    let run = await callOp(ctx, "run.start", {
      workflow: "t/budget", repo: tmpDir(), brief: "Do X",
    }, stubDeps()) as RunRow;
    for (let i = 0; i < 5; i++) countOrchestratorTurn(ctx, run.id);
    expect(budgetAllowsTurn(ctx, getRun(ctx, run.id)!)).toBe(false);

    run = await callOp(ctx, "run.set_budget", {
      id: run.id, orchestrator_turns: 10, expect_rev: getRun(ctx, run.id)!.rev,
    }) as RunRow;
    expect(parseBudget(run.budget).orchestratorTurns).toBe(10);
    expect(budgetAllowsTurn(ctx, run)).toBe(true);
    expect(run.orchestratorState).not.toBe("blocked");

    const stopped = await callOp(ctx, "run.stop", { id: run.id, expect_rev: run.rev }) as RunRow;
    expect(stopped.status).toBe("stopped");
  });

  test("ordinary pacer msg between non-run tasks is never counted", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    const run = await callOp(ctx, "run.start", {
      workflow: "t/budget", repo: tmpDir(), brief: "Do X",
    }, stubDeps()) as RunRow;
    const a = createTask(ctx, { brief: { goal: "a", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    const b = createTask(ctx, { brief: { goal: "b", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    // Force settled so a message turn could start — still must not touch run spent.
    updateTask(ctx, b.id, t => {
      t.state = "done";
      t.result = { ...t.result, executor: "claude-code", backend: "direct" } as TaskRecord["result"];
    });
    const before = parseSpent(getRun(ctx, run.id)!.spent);
    try {
      await sendMessage(
        { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: a.id } },
        { to: `task:${b.id}`, body: "hello" },
      );
    } catch {
      // Delivery may refuse without a full messaging setup; counting must still be zero.
    }
    expect(parseSpent(getRun(ctx, run.id)!.spent)).toEqual(before);
    expect(stepByTask(ctx, a.id)).toBeNull();
  });

  test("run.set_budget is person-only", async () => {
    const ctx = fakeCtx({ now: NOW });
    await callOp(ctx, "workflow.add", { source: CHAIN });
    const run = await callOp(ctx, "run.start", {
      workflow: "t/budget", repo: tmpDir(), brief: "Do X",
    }, stubDeps()) as RunRow;
    const exec = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor" } };
    expect((await fail(callOp(exec, "run.set_budget", {
      id: run.id, orchestrator_turns: 99, expect_rev: run.rev,
    })))?.code).toBe("not_allowed");
  });

  test("wake-ups within 30s coalesce unless by_person", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const def = {
      id: "t/coal", version: 1,
      steps: {
        a: { type: "agent" as const, kind: "research", prompt: "A" },
        done: { type: "end" as const },
      },
      edges: [{ from: "a", to: "done" }],
      entry: "a",
    };
    addDefinition(ctx, def, "x");
    const run = insertRun(ctx, { workflow: "t/coal", version: 1, repo: tmpDir(), brief: "b" });
    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_settled", ref: "a#1", createdAt: NOW,
    });
    // Too fresh: no turn yet.
    expect(await startTurn(ctx, run.id, orchDeps(ctx))).toBeNull();
    // After 30s: turn starts.
    const later = { ...ctx, now: NOW + 30 };
    const turn = await startTurn(later, run.id, orchDeps(later));
    expect(turn).not.toBeNull();
  });

  test("deriveWorkflowAttention surfaces budget and failure with expect_rev actions", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    let run = await callOp(ctx, "run.start", {
      workflow: "t/budget", repo: tmpDir(), brief: "Do X",
    }, stubDeps()) as RunRow;
    for (let i = 0; i < 5; i++) countOrchestratorTurn(ctx, run.id);
    run = getRun(ctx, run.id)!;
    const spent = deriveWorkflowAttention(ctx).find(i => i.id === `budget_spent:${run.id}`);
    expect(spent?.severity).toBe("decide");
    expect(spent?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "run.set_budget", params: expect.objectContaining({ id: run.id, expect_rev: run.rev }) }),
      expect.objectContaining({ op: "run.stop", params: expect.objectContaining({ id: run.id, expect_rev: run.rev }) }),
    ]));

    // Failure block: retry_orchestrator clears it; budget block refuses retry.
    // Clear blockedBy so this is not still classified as a budget spend (structured marker).
    const spentAfterBudget = parseSpent(run.spent);
    delete spentAfterBudget.blockedBy;
    updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "orchestrator failed 3 times",
      nextWakeAt: null,
      spent: serializeSpent(spentAfterBudget),
    });
    run = getRun(ctx, run.id)!;
    const failed = deriveWorkflowAttention(ctx).find(i => i.id === `orchestrator_failed:${run.id}`);
    expect(failed?.actions.map(a => a.op)).toEqual([
      "run.retry_orchestrator", "run.set_planner", "run.stop",
    ]);
    expect(failed?.actions[0]?.params).toEqual(expect.objectContaining({ id: run.id, expect_rev: run.rev }));
    run = await callOp(ctx, "run.retry_orchestrator", { id: run.id, expect_rev: run.rev }) as RunRow;
    expect(run.orchestratorState).toBe("idle");

    for (let i = 0; i < 5; i++) countOrchestratorTurn(ctx, run.id);
    run = getRun(ctx, run.id)!;
    expect((await fail(callOp(ctx, "run.retry_orchestrator", {
      id: run.id, expect_rev: run.rev,
    })))?.code).toBe("not_allowed");
  });

  test("message turn budget queues when spent and counts on real startTurnIfIdle", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const sender = insertRun(ctx, {
      workflow: "t/msg-a", version: 1, repo: tmpDir(), brief: "a",
      budget: serializeBudget({ orchestratorTurns: 10, messageTurns: 1 }),
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    const receiver = insertRun(ctx, {
      workflow: "t/msg-b", version: 1, repo: tmpDir(), brief: "b",
      budget: serializeBudget({ orchestratorTurns: 10, messageTurns: 5 }),
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    const fromTask = createTask(ctx, { brief: { goal: "from", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    const toTask = createTask(ctx, { brief: { goal: "to", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 600 });
    insertStep(ctx, { runId: sender.id, stepId: "a", attempt: 1, branch: "", taskId: fromTask.id, status: "running" });
    insertStep(ctx, { runId: receiver.id, stepId: "b", attempt: 1, branch: "", taskId: toTask.id, status: "running" });
    updateTask(ctx, toTask.id, t => {
      t.state = "done";
      t.result = { ...t.result, executor: "claude-code", backend: "direct" } as TaskRecord["result"];
    });

    // First cross-run message: turn start counts against the sender.
    const first = await sendMessage(
      { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: fromTask.id } },
      { to: `task:${toTask.id}`, body: "one" },
      { spawnRunner: (() => 1) as never },
    );
    // Delivery may be turn_started or queued depending on messaging admission; count via the real path.
    if (first.delivery !== "turn_started") {
      expect(startTurnIfIdle(ctx, toTask.id, (() => 1) as never)).toBe("turn_started");
    }
    expect(parseSpent(getRun(ctx, sender.id)!.spent).messageTurns).toBe(1);
    expect(budgetAllowsMessage(ctx, sender.id)).toBe(false);
    const msgAttn = deriveWorkflowAttention(ctx).find(i => i.id === `budget_msg_spent:${sender.id}`);
    expect(msgAttn?.title).toMatch(/Message turn budget spent/i);
    expect(msgAttn?.detail).not.toMatch(/orchestrator turn budget/i);

    // Second message while spent: queued, not counted again.
    updateTask(ctx, toTask.id, t => {
      t.state = "done";
      t.result = { ...t.result, executor: "claude-code", backend: "direct" } as TaskRecord["result"];
    });
    const second = await sendMessage(
      { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: fromTask.id } },
      { to: `task:${toTask.id}`, body: "two" },
      { spawnRunner: (() => 1) as never },
    );
    expect(second.delivery).toBe("queued");
    expect(parseSpent(getRun(ctx, sender.id)!.spent).messageTurns).toBe(1);
    expect(msgStore.pendingFor(ctx, `task:${toTask.id}`).some(m => m.body === "two")).toBe(true);
  });

  test("settleTurn does not clear a budget-exhausted blocked marker", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, {
      workflow: "t/settle-budget", version: 1, repo: tmpDir(), brief: "b",
      budget: serializeBudget({ orchestratorTurns: 1, messageTurns: 5 }),
      spent: serializeSpent({ orchestratorTurns: 1, messageTurns: 0 }),
    });
    updateRun(ctx, run.id, 1, { orchestratorState: "blocked", reason: "turn budget spent" });
    expect(await startTurn(ctx, run.id, orchDeps(ctx))).toBeNull();
    // Insert a live turn and settle done — budget block must remain.
    const { insertTurn } = await import("../src/workflow/wakeups");
    const row = insertTurn(ctx, {
      id: "turn_budgetsettle1", runId: run.id, planner: "claude-code",
      status: "running", startedAt: NOW, deadline: NOW + 1000, failures: 0,
    });
    await settleTurn(ctx, row.id, { outcome: "done" });
    expect(getRun(ctx, run.id)!.orchestratorState).toBe("blocked");
    expect(getRun(ctx, run.id)!.reason).toMatch(/budget/);
  });

  test("80% message warning does not say orchestrator turn budget", () => {
    const ctx = fakeCtx({ now: NOW });
    const run = insertRun(ctx, {
      workflow: "t/msg-warn", version: 1, repo: tmpDir(), brief: "b",
      budget: serializeBudget({ orchestratorTurns: 100, messageTurns: 5 }),
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    for (let i = 0; i < 4; i++) countMessageTurn(ctx, run.id);
    const warn = deriveWorkflowAttention(ctx).find(i => i.id === `budget_msg_warn:${run.id}`);
    expect(warn?.title).toMatch(/message turn budget/i);
    expect(warn?.detail).toMatch(/4 of 5 message turns/i);
    expect(warn?.detail).not.toMatch(/orchestrator/i);
  });

  // I3: each emitted attention action must succeed via callOp; Raise budget needs
  // concrete turns; Switch planner must target a different planner; since/raisedAt
  // stay stable when the clock advances.
  test("attention actions execute through callOp with concrete params and stable since", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    let run = await callOp(ctx, "run.start", {
      workflow: "t/budget", repo: tmpDir(), brief: "Do X",
    }, stubDeps()) as RunRow;
    for (let i = 0; i < 5; i++) countOrchestratorTurn(ctx, run.id);
    run = getRun(ctx, run.id)!;
    const spent = deriveWorkflowAttention(ctx).find(i => i.id === `budget_spent:${run.id}`);
    expect(spent).toBeTruthy();
    const raise = spent!.actions.find(a => a.label === "Raise budget");
    expect(raise?.op).toBe("run.set_budget");
    expect(raise?.params).toEqual(expect.objectContaining({
      id: run.id,
      expect_rev: run.rev,
      orchestrator_turns: expect.any(Number),
    }));
    expect((raise!.params as { orchestrator_turns: number }).orchestrator_turns)
      .toBeGreaterThan(parseBudget(run.budget).orchestratorTurns);
    const since0 = spent!.since;
    const raised0 = spent!.raisedAt;
    expect(since0).toBe(raised0);
    expect(since0).toBeGreaterThan(0);
    // Clock advances: since/raisedAt must not drift with ctx.now.
    const later = { ...ctx, now: NOW + 50_000 };
    const spentLater = deriveWorkflowAttention(later).find(i => i.id === `budget_spent:${run.id}`);
    expect(spentLater?.since).toBe(since0);
    expect(spentLater?.raisedAt).toBe(raised0);
    // Real callOp path for Raise budget.
    run = await callOp(ctx, raise!.op, raise!.params) as RunRow;
    expect(parseBudget(run.budget).orchestratorTurns)
      .toBe((raise!.params as { orchestrator_turns: number }).orchestrator_turns);
    expect(run.orchestratorState).not.toBe("blocked");

    // Orchestrator-failed attention: Switch planner must not be the current one.
    run = getRun(ctx, run.id)!;
    updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "planner failed 3×",
      planner: "claude-code",
    });
    run = getRun(ctx, run.id)!;
    const failed = deriveWorkflowAttention(ctx).find(i => i.id === `orchestrator_failed:${run.id}`);
    expect(failed).toBeTruthy();
    const switchPlanner = failed!.actions.find(a => a.label === "Switch planner");
    expect(switchPlanner?.op).toBe("run.set_planner");
    const target = (switchPlanner!.params as { planner: string }).planner;
    expect(target).not.toBe(run.planner ?? "claude-code");
    for (const action of failed!.actions.filter(a => a.op !== "run.stop")) {
      const params = { ...action.params, expect_rev: getRun(ctx, run.id)!.rev };
      run = await callOp(ctx, action.op, params) as RunRow;
    }
    expect(run.pendingPlanner).toBe(target);
    expect(run.orchestratorState).toBe("idle");
  });

  // G2: afterSpend stamps blockedBy during the last allowed startTurn, then the
  // turn patch clears the blocked state but leaves the marker; a later raise +
  // failure block must show orchestrator_failed and accept retry_orchestrator.
  test("after budget raise, failure block is not misclassified as budget_spent", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const tiny = `
id: t/g2-budget
version: 1
policy:
  budget: { orchestrator_turns: 1, message_turns: 5 }
steps:
  one: { type: agent, kind: research, prompt: "One" }
  done: { type: end }
edges:
  - [one, done]
`;
    await callOp(ctx, "workflow.add", { source: tiny });
    let run = await callOp(ctx, "run.start", {
      workflow: "t/g2-budget", repo: tmpDir(), brief: "Do X",
    }, stubDeps()) as RunRow;

    // Real startTurn path: last allowed turn stamps blockedBy then patches to "turn".
    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_failed", ref: `${run.id}/one#1`, createdAt: NOW,
    });
    const first = await startTurn({ ...ctx, now: NOW + COALESCE_WINDOW_S }, run.id, orchDeps(ctx));
    expect(first).not.toBeNull();
    run = getRun(ctx, run.id)!;
    expect(run.orchestratorState).toBe("turn");
    // Mid-turn: blockedBy must not stick after the turn patch (G2).
    expect(parseSpent(run.spent).blockedBy).toBeUndefined();
    await settleTurn(ctx, first!.id, { outcome: "done" });

    // Exhausted: settle re-asserts the budget block; no further turns until raise.
    run = getRun(ctx, run.id)!;
    expect(isBudgetBlocked(run)).toBe(true);
    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_failed", ref: `${run.id}/one#1`, createdAt: NOW + 100,
    });
    expect(await startTurn({ ...ctx, now: NOW + 100 + COALESCE_WINDOW_S }, run.id, orchDeps(ctx))).toBeNull();

    run = await callOp(ctx, "run.set_budget", {
      id: run.id, orchestrator_turns: 10, expect_rev: getRun(ctx, run.id)!.rev,
    }) as RunRow;
    expect(parseSpent(run.spent).blockedBy).toBeUndefined();
    expect(budgetAllowsTurn(ctx, run)).toBe(true);

    // Fail enough consecutive turns to block as planner-failed (D1: 4th failure).
    for (let i = 0; i < 4; i++) {
      const at = NOW + 200 + i * 1000;
      addWakeup(workflowDatabase(ctx), {
        runId: run.id, cause: "step_failed", ref: `${run.id}/one#1`, createdAt: at,
      });
      const turn = await startTurn({ ...ctx, now: at + COALESCE_WINDOW_S }, run.id, orchDeps(ctx));
      expect(turn).not.toBeNull();
      await settleTurn({ ...ctx, now: at + COALESCE_WINDOW_S + 1 }, turn!.id, {
        outcome: "failed", reason: "planner crashed",
      });
    }
    run = getRun(ctx, run.id)!;
    expect(run.orchestratorState).toBe("blocked");
    expect(run.reason).toMatch(/planner failed/i);
    expect(isBudgetBlocked(run)).toBe(false);

    const attn = deriveWorkflowAttention(ctx);
    expect(attn.find(i => i.id === `orchestrator_failed:${run.id}`)).toBeTruthy();
    expect(attn.find(i => i.id === `budget_spent:${run.id}`)).toBeUndefined();

    run = await callOp(ctx, "run.retry_orchestrator", {
      id: run.id, expect_rev: run.rev,
    }) as RunRow;
    expect(run.orchestratorState).toBe("idle");
  });
});
