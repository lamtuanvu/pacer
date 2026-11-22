// Phase 2 Task 10: orchestrator leaves ordinary tasks, planner sessions,
// work-grant authorization, messaging and non-prg_ callers unchanged.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  authorizeWorkOperation,
  TASK_REVIEW_REFUSAL,
  TASK_REVIEW_VARIANTS_REFUSAL,
} from "../src/core/work";
import { CoreError } from "../src/core/errors";
import { issueWorkGrant, registerWork } from "../src/dispatch/work";
import { isExecutorSession, isOrchestratorSession, plannerPolicyApplies } from "../src/install/role";
import { sendMessage } from "../src/messaging/send";
import { createTask, readTask, taskDatabase, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { callOp, type OpDeps } from "../src/api/ops";
import type { DelegateInput } from "../src/tasks/api";
import { advanceRuns } from "../src/workflow/tick";
import { getRun, stepsOfRun, workflowDatabase } from "../src/workflow/store";
import { parseSpent } from "../src/workflow/budget";
import { openWakeups } from "../src/workflow/wakeups";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";

const NOW = 1_700_000_000;

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

function writePlanner(ctx: Ctx) {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

/** Managed root + child + unrelated plain task, with a live work grant on the root. */
function grantedWork(ctx: Ctx) {
  const parent = createTask(ctx, { brief: { goal: "root", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, parent.id, { allowDelegation: true });
  updateTask(ctx, parent.id, t => { t.state = "running"; });
  const child = createTask(ctx, { brief: { goal: "child", repo: parent.brief.repo }, kind: "debug", requestedExecutor: null, timeoutS: 60 });
  registerWork(ctx, child.id, {}, parent.id);
  const plain = createTask(ctx, { brief: { goal: "plain", repo: tmpDir() }, kind: "docs", requestedExecutor: null, timeoutS: 60 });
  const grant = issueWorkGrant(ctx, parent.id, 1);
  const executor = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_WORK_GRANT: grant } };
  return { parent, child, plain, grant, executor };
}

function outcome(fn: () => void): { ok: true } | { ok: false; code: string; message: string } {
  try {
    fn();
    return { ok: true };
  } catch (e) {
    const err = e as CoreError;
    return { ok: false, code: err.code, message: err.message };
  }
}

function wakeupCount(ctx: Ctx): number {
  return workflowDatabase(ctx).query<{ n: number }, []>(
    "SELECT count(*) AS n FROM workflow_wakeups",
  ).get()!.n;
}

describe("ordinary planner sessions", () => {
  test("role detection is unchanged: planner is neither executor nor orchestrator", () => {
    const planner = fakeCtx({ env: { PACER_ROLE: "planner" } });
    const bare = fakeCtx();
    expect(isExecutorSession(planner)).toBe(false);
    expect(isOrchestratorSession(planner)).toBe(false);
    expect(isExecutorSession(bare)).toBe(false);
    expect(isOrchestratorSession(bare)).toBe(false);
    expect(isExecutorSession(fakeCtx({ env: { PACER_ROLE: "executor" } }))).toBe(true);
    expect(isOrchestratorSession(fakeCtx({ env: { PACER_ROLE: "orchestrator" } }))).toBe(true);
    // Orchestrator still does not count as an executor for planner-policy gates.
    expect(isExecutorSession(fakeCtx({ env: { PACER_ROLE: "orchestrator" } }))).toBe(false);
  });

  test("plannerPolicyApplies still keys off the strategy planner for ordinary sessions", () => {
    const ctx = fakeCtx();
    writePlanner(ctx);
    expect(plannerPolicyApplies(ctx, "claude-code")).toBe(true);
    expect(plannerPolicyApplies(ctx, "codex")).toBe(false);
    expect(plannerPolicyApplies({ ...ctx, env: { ...ctx.env, PACER_ROLE: "executor" } }, "claude-code")).toBe(false);
    expect(plannerPolicyApplies({ ...ctx, env: { ...ctx.env, PACER_ROLE: "orchestrator" } }, "claude-code")).toBe(true);
  });
});

describe("ordinary task review/stop with work grants", () => {
  test("executor with a work grant may accept/reject a child and stop in-scope work; never its own task", () => {
    const ctx = fakeCtx({ now: NOW });
    const { parent, child, plain, executor } = grantedWork(ctx);

    for (const verdict of ["accept", "reject"] as const) {
      expect(outcome(() => authorizeWorkOperation(executor, "task.review", { id: child.id, verdict }))).toEqual({ ok: true });
    }
    for (const verdict of ["send_back", "retry"] as const) {
      expect(outcome(() => authorizeWorkOperation(executor, "task.review", { id: child.id, verdict }))).toEqual({
        ok: false, code: "not_allowed", message: TASK_REVIEW_VARIANTS_REFUSAL,
      });
    }
    expect(outcome(() => authorizeWorkOperation(executor, "task.review", { id: parent.id, verdict: "accept" }))).toEqual({
      ok: false, code: "not_allowed", message: TASK_REVIEW_REFUSAL,
    });
    expect(outcome(() => authorizeWorkOperation(executor, "task.review", { id: plain.id, verdict: "accept" }))).toEqual({
      ok: false, code: "not_allowed", message: TASK_REVIEW_REFUSAL,
    });

    // Stop stays on the work-grant path: dispatch.stop is allowed in scope; task.stop is not on the grant allow-list.
    expect(outcome(() => authorizeWorkOperation(executor, "dispatch.stop", { id: child.id }))).toEqual({ ok: true });
    expect(outcome(() => authorizeWorkOperation(executor, "dispatch.stop", { id: parent.id }))).toEqual({ ok: true });
    expect(outcome(() => authorizeWorkOperation(executor, "dispatch.stop", { id: plain.id })).ok).toBe(false);
    expect(outcome(() => authorizeWorkOperation(executor, "task.stop", { id: child.id }))).toEqual({
      ok: false, code: "not_allowed", message: "Operation is not allowed by this work grant",
    });
  });
});

describe("ordinary settlements leave wake-ups alone", () => {
  test("settling an ordinary task creates no wake-up rows even when a run is live", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: `
id: t/scope
version: 1
steps:
  draft: { type: agent, kind: research, prompt: "Draft: {{brief}}" }
  done: { type: end }
edges:
  - [draft, done, "result.ok == true"]
` });
    const run = await callOp(ctx, "run.start", { workflow: "t/scope", repo: tmpDir(), brief: "Do X" }, stubDeps()) as { id: string };
    expect(stepsOfRun(ctx, run.id)).toHaveLength(1);
    expect(wakeupCount(ctx)).toBe(0);
    expect(openWakeups(ctx, run.id)).toEqual([]);

    const plain = createTask(ctx, { brief: { goal: "plain work", repo: tmpDir() }, kind: "docs", requestedExecutor: null, timeoutS: 600 });
    updateTask(ctx, plain.id, t => { t.state = "running"; });
    updateTask(ctx, plain.id, t => { t.state = "done"; });
    await advanceRuns(ctx);

    expect(wakeupCount(ctx)).toBe(0);
    expect(openWakeups(ctx, run.id)).toEqual([]);
    expect(taskDatabase(ctx).query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM workflow_wakeups WHERE ref LIKE ?",
    ).get(`%${plain.id}%`)!.n).toBe(0);
    expect(readTask(ctx, plain.id)!.state).toBe("done");
    expect(getRun(ctx, run.id)!.status).toBe("running");
  });
});

describe("ordinary messaging is uncounted", () => {
  test("pacer msg between non-run tasks does not spend a run's message budget", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: `
id: t/msg-scope
version: 1
policy:
  budget: { orchestrator_turns: 5, message_turns: 3 }
steps:
  one: { type: agent, kind: research, prompt: "One" }
  done: { type: end }
edges:
  - [one, done]
` });
    const run = await callOp(ctx, "run.start", {
      workflow: "t/msg-scope", repo: tmpDir(), brief: "Do X",
    }, stubDeps()) as { id: string };
    const a = createTask(ctx, { brief: { goal: "a", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    const b = createTask(ctx, { brief: { goal: "b", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    updateTask(ctx, b.id, t => {
      t.state = "done";
      t.result = { ...t.result, executor: "claude-code", backend: "direct" } as TaskRecord["result"];
    });
    const before = parseSpent(getRun(ctx, run.id)!.spent);
    expect(before.messageTurns).toBe(0);
    try {
      await sendMessage(
        { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: a.id } },
        { to: `task:${b.id}`, body: "hello" },
      );
    } catch {
      // Delivery may refuse without a full messaging setup; counting must still be zero.
    }
    expect(parseSpent(getRun(ctx, run.id)!.spent)).toEqual(before);
    // A work-grant holder may still authorize msg.send; the spend path stays run-scoped.
    registerWork(ctx, a.id, { allowDelegation: true });
    updateTask(ctx, a.id, t => { t.state = "running"; });
    const granted = {
      ...ctx,
      env: { ...ctx.env, PACER_ROLE: "executor", PACER_WORK_GRANT: issueWorkGrant(ctx, a.id, 1) },
    };
    expect(outcome(() => authorizeWorkOperation(granted, "msg.send", { to: `task:${b.id}`, body: "hi" }))).toEqual({ ok: true });
    expect(parseSpent(getRun(ctx, run.id)!.spent)).toEqual(before);
  });
});
