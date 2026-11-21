// Phase 2 Task 4+: orchestrator turns driven by wake-ups (start/settle, tick
// orchestrate phase, retry/limit/deadline, orchestrator steps and choose_workflow).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { SpawnRunner } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, getRun, insertRun, insertStep, stepByTask, stepsOfRun, updateRun, workflowDatabase,
} from "../src/workflow/store";
import { chooseWorkflow, onTaskSettled, recordStepResult, startRun, startStep, type EngineDeps } from "../src/workflow/engine";
import { listTasksWhere } from "../src/tasks/store";
import { advanceRuns } from "../src/workflow/tick";
import {
  addWakeup, getTurn, liveTurn, openWakeups, insertTurn,
} from "../src/workflow/wakeups";
import {
  buildHandoverPrompt, buildTurnPrompt, getOrchestratorAttention, recoverOrphanTurns, settleTurn, startTurn,
  type OrchestratorDeps,
} from "../src/workflow/orchestrator";
import { COALESCE_WINDOW_S } from "../src/workflow/budget";
import { deriveWorkflowAttention } from "../src/workflow/attention";
import { issueRunGrant, verifyRunGrant } from "../src/workflow/run-grant";
import { isExecutorSession, isOrchestratorSession } from "../src/install/role";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;
/** Wake-ups must age past the coalesce window before a turn starts. */
const READY = NOW + COALESCE_WINDOW_S;

function fakeDeps() {
  const byRequest = new Map<string, TaskRecord>();
  const inputs: Parameters<EngineDeps["delegate"]>[1][] = [];
  const delegate: EngineDeps["delegate"] = async (ctx, input: DelegateInput) => {
    inputs.push(input);
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
  const deps: EngineDeps = {
    delegate,
    stopTask: (ctx, id) => updateTask(ctx, id, t => { t.state = "stopped"; }),
  };
  return { deps, inputs };
}

const settle = (ctx: Ctx, taskId: string, state: TaskRecord["state"] = "done") =>
  updateTask(ctx, taskId, t => { t.state = state; });

/** Minimal strategy so loadStrategy resolves a planner for startTurn. */
function writePlanner(ctx: Ctx, agent = "claude-code"): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: ${agent}\nproviders:\n  ${agent}: {}\n`);
}

const chain: WorkflowDef = {
  id: "t/orch-chain",
  version: 1,
  steps: {
    one: { type: "agent", kind: "research", prompt: "One" },
    two: { type: "agent", kind: "research", prompt: "Two" },
    done: { type: "end" },
  },
  edges: [
    { from: "one", to: "two" },
    { from: "two", to: "done" },
  ],
  entry: "one",
};

describe("Task 4: starting and settling turns", () => {
  test("a failed step writes a wake-up; the next tick starts one turn", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const launches: { taskId: string; env: Record<string, string | undefined> }[] = [];
    const spawn: SpawnRunner = (c, id) => {
      launches.push({ taskId: id, env: { ...c.env } });
      return 1;
    };
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);
    expect(getRun(ctx, r.id)!.status).toBe("waiting");
    const open = openWakeups(ctx, r.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ cause: "step_failed", ref: `${r.id}/one#1` });

    const orch: OrchestratorDeps = { spawn, plannerEligible: () => true };
    const out = await advanceRuns({ ...ctx, now: READY }, spawn, deps, orch);
    expect(out.orchestrated).toBeGreaterThanOrEqual(1);
    const turns = workflowDatabase(ctx).query<{ id: string; status: string; task_id: string | null }, [string]>(
      "SELECT id, status, task_id FROM workflow_turns WHERE run_id = ?",
    ).all(r.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe("running");
    expect(launches).toHaveLength(1);
    // Launch/_run env must not carry the grant or orchestrator role (round-2 B1).
    expect(launches[0]!.env.PACER_RUN_GRANT).toBeUndefined();
    expect(launches[0]!.env.PACER_ROLE).not.toBe("orchestrator");
    expect(launches[0]!.env.PACER_RUN_ID).toBe(r.id);
    expect(launches[0]!.env.PACER_TURN_ID).toBe(turns[0]!.id);
    // Prompt on the orchestrator task never contains a raw grant.
    const orchTask = readTask(ctx, turns[0]!.task_id!)!;
    expect(orchTask.brief.goal).not.toMatch(/prg_[0-9a-f]{64}/);
    expect(orchTask.kind).toBe("orchestrate");
    expect(stepByTask(ctx, orchTask.id)).toBeNull();
  });

  test("two ticks never start two live turns; wake-ups during a turn wait", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);
    const orch: OrchestratorDeps = { spawn, plannerEligible: () => true };
    await advanceRuns({ ...ctx, now: READY }, spawn, deps, orch);
    const first = workflowDatabase(ctx).query<{ id: string }, [string]>(
      "SELECT id FROM workflow_turns WHERE run_id = ? AND status IN ('starting','running')",
    ).all(r.id);
    expect(first).toHaveLength(1);

    // A second wake-up arrives while the turn is live.
    addWakeup(workflowDatabase(ctx), { runId: r.id, cause: "message", ref: "m-1", createdAt: READY + 1 });
    await advanceRuns({ ...ctx, now: READY + 1 }, spawn, deps, orch);
    const live = workflowDatabase(ctx).query<{ id: string }, [string]>(
      "SELECT id FROM workflow_turns WHERE run_id = ? AND status IN ('starting','running')",
    ).all(r.id);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(first[0]!.id);
    expect(openWakeups(ctx, r.id).map(w => w.ref)).toEqual(["m-1"]);

    // Settle the first turn; the next tick starts one turn for the waiting wake-up.
    await settleTurn(ctx, first[0]!.id, { outcome: "done" });
    expect(getTurn(ctx, first[0]!.id)!.status).toBe("done");
    await advanceRuns({ ...ctx, now: READY + 1 + COALESCE_WINDOW_S }, spawn, deps, orch);
    const all = workflowDatabase(ctx).query<{ id: string; status: string }, [string]>(
      "SELECT id, status FROM workflow_turns WHERE run_id = ?",
    ).all(r.id);
    expect(all).toHaveLength(2);
    expect(all.filter(t => t.status === "done")).toHaveLength(1);
    expect(all.filter(t => t.status === "running")).toHaveLength(1);
    expect(all.find(t => t.status === "done")!.id).toBe(first[0]!.id);
    expect(openWakeups(ctx, r.id)).toHaveLength(0);
  });

  test("a mechanical edge advances without any wake-up", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    recordStepResult(ctx, s1.taskId!, { ok: true });
    settle(ctx, s1.taskId!);
    await advanceRuns(ctx, spawn, deps);
    expect(openWakeups(ctx, r.id)).toHaveLength(0);
    expect(getRun(ctx, r.id)!.status).toBe("running");
    expect(stepsOfRun(ctx, r.id)).toHaveLength(2);
    expect(workflowDatabase(ctx).query("SELECT id FROM workflow_turns WHERE run_id = ?",).all(r.id)).toHaveLength(0);
  });

  test("startTurn returns null when a live turn already exists", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b" });
    addWakeup(workflowDatabase(ctx), { runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW - COALESCE_WINDOW_S });
    insertTurn(ctx, {
      id: "turn_live",
      runId: run.id,
      planner: "claude-code",
      status: "running",
      startedAt: NOW,
      deadline: NOW + 1200,
    });
    const result = await startTurn(ctx, run.id, { spawn: () => 1, plannerEligible: () => true });
    expect(result).toBeNull();
  });

  test("settleTurn done completes wake-ups and revokes the grant; prompt uses data fences", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "secret brief" });
    addDefinition(ctx, chain, "source");
    addWakeup(workflowDatabase(ctx), { runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW - COALESCE_WINDOW_S });
    const spawn: SpawnRunner = () => 1;
    const turn = await startTurn(ctx, run.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    // Grant is issued for the agent by the runner; issue one here to pin revoke-on-settle.
    const grant = issueRunGrant(ctx, { runId: run.id, turnId: turn!.id, deadline: turn!.deadline });
    expect(verifyRunGrant(ctx, grant)).not.toBeNull();
    const task = readTask(ctx, turn!.taskId!)!;
    expect(task.brief.goal).toContain("--- data ");
    expect(task.brief.goal).toContain("--- end data ");
    expect(task.brief.goal).not.toContain(grant);
    expect(Buffer.byteLength(task.brief.goal, "utf8")).toBeLessThanOrEqual(32 * 1024);
    // buildTurnPrompt itself fences data the same way; wake-ups come before the brief.
    const sample = buildTurnPrompt(ctx, run, [{ runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW, byPerson: false }], chain, []);
    expect(sample).toContain("--- data ");
    expect(sample).toContain("secret brief");
    const wakeAt = sample.indexOf("wake-up step_failed");
    const briefAt = sample.indexOf("from the brief");
    expect(wakeAt).toBeGreaterThanOrEqual(0);
    expect(briefAt).toBeGreaterThan(wakeAt);
    expect(sample.match(/nonce ([0-9a-f]{16}):/)?.[1]?.length).toBe(16);

    await settleTurn(ctx, turn!.id, { outcome: "done" });
    expect(getTurn(ctx, turn!.id)!.status).toBe("done");
    expect(openWakeups(ctx, run.id)).toHaveLength(0);
    expect(verifyRunGrant(ctx, grant)).toBeNull();
  });

  test("handover prompt fences brief/decisions and pending planner survives a failed turn", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "handover brief" });
    addDefinition(ctx, chain, "source");
    updateRun(ctx, run.id, run.rev, { planner: "claude-code", pendingPlanner: "codex" });
    const sample = buildHandoverPrompt(ctx, getRun(ctx, run.id)!, [
      { runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW, byPerson: false },
    ], chain, []);
    expect(sample).toContain("--- data ");
    expect(sample).toContain("from the brief");
    expect(sample).toContain("handover brief");
    expect(sample).toContain("decisions");
    expect(sample.indexOf("wake-up")).toBeLessThan(sample.indexOf("from the brief"));

    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW - COALESCE_WINDOW_S,
    });
    const spawn: SpawnRunner = () => 1;
    const turn = await startTurn(ctx, run.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    expect(getRun(ctx, run.id)!.pendingPlanner).toBe("codex");
    await settleTurn(ctx, turn!.id, { outcome: "failed", reason: "crash" });
    expect(getRun(ctx, run.id)!.pendingPlanner).toBe("codex");
    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_failed", ref: "one#2", createdAt: NOW - COALESCE_WINDOW_S,
    });
    const again = await startTurn({ ...ctx, now: READY + 1000 }, run.id, { spawn, plannerEligible: () => true });
    expect(again).not.toBeNull();
    expect(readTask(ctx, again!.taskId!)!.brief.goal).toContain("planner handover");
    await settleTurn(ctx, again!.id, { outcome: "done" });
    expect(getRun(ctx, run.id)!.pendingPlanner).toBeUndefined();
    expect(getRun(ctx, run.id)!.planner).toBe("codex");
  });

  test("isOrchestratorSession is the third role; orchestrator is not an executor", () => {
    const ctx = fakeCtx({ env: { PACER_ROLE: "orchestrator" } });
    expect(isOrchestratorSession(ctx)).toBe(true);
    expect(isExecutorSession(ctx)).toBe(false);
    expect(isOrchestratorSession(fakeCtx({ env: { PACER_ROLE: "executor" } }))).toBe(false);
  });
});

describe("Task 5: failed, limited and overdue turns", () => {
  // D1 / G6: retry at 60s, 300s, 900s; block (ask) on the 4th consecutive failure.
  test("four failures then blocked with attention; no fifth turn", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);

    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const t = await startTurn({ ...ctx, now: READY + i * 10_000 }, r.id, { spawn, plannerEligible: () => true });
      expect(t, `turn ${i + 1}`).not.toBeNull();
      await settleTurn({ ...ctx, now: READY + i * 10_000 + 1 }, t!.id, { outcome: "failed", reason: "crash" });
      const after = getRun(ctx, r.id)!;
      if (i < 3) {
        expect(after.orchestratorState).toBe("retrying");
        delays.push((after.nextWakeAt ?? 0) - (READY + i * 10_000 + 1));
      }
    }
    expect(delays).toEqual([60, 300, 900]);
    const blocked = getRun({ ...ctx, now: NOW + 30_000 }, r.id)!;
    expect(blocked.orchestratorState).toBe("blocked");
    expect(blocked.reason).toMatch(/planner failed 4/);
    const attn = getOrchestratorAttention(ctx, r.id);
    expect(attn?.kind).toBe("orchestrator_failed");
    expect(attn?.actions.map(a => a.label)).toEqual(["Retry now", "Switch to Codex", "Stop run"]);
    expect(attn?.actions[0]).toMatchObject({
      op: "run.retry_orchestrator",
      params: { id: r.id, expect_rev: expect.any(Number) },
    });
    expect(attn?.actions[1]).toMatchObject({
      op: "run.set_planner",
      params: expect.objectContaining({ id: r.id, expect_rev: expect.any(Number), planner: expect.any(String) }),
    });

    const fifth = await startTurn({ ...ctx, now: NOW + 100_000 }, r.id, { spawn, plannerEligible: () => true });
    expect(fifth).toBeNull();
  });

  test("failure count resets after a done turn (fail, fail, done, fail → 1, 2, 0, 1)", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b" });
    const spawn: SpawnRunner = () => 1;
    const start = async (n: number) => {
      // Space turns past retry backoff (60s / 300s) so startTurn is not held.
      const at = READY + n * 1000;
      addWakeup(workflowDatabase(ctx), {
        runId: run.id, cause: "step_failed", ref: `f#${n}`, createdAt: at - COALESCE_WINDOW_S,
      });
      return { turn: await startTurn({ ...ctx, now: at }, run.id, { spawn, plannerEligible: () => true }), at };
    };
    const s1 = await start(1);
    await settleTurn({ ...ctx, now: s1.at + 1 }, s1.turn!.id, { outcome: "failed", reason: "a" });
    expect(getTurn(ctx, s1.turn!.id)!.failures).toBe(1);
    const s2 = await start(2);
    await settleTurn({ ...ctx, now: s2.at + 1 }, s2.turn!.id, { outcome: "failed", reason: "b" });
    expect(getTurn(ctx, s2.turn!.id)!.failures).toBe(2);
    const s3 = await start(3);
    await settleTurn({ ...ctx, now: s3.at + 1 }, s3.turn!.id, { outcome: "done" });
    expect(getTurn(ctx, s3.turn!.id)!.failures).toBe(0);
    const s4 = await start(4);
    expect(s4.turn!.failures).toBe(0); // carried from the done turn
    await settleTurn({ ...ctx, now: s4.at + 1 }, s4.turn!.id, { outcome: "failed", reason: "c" });
    expect(getTurn(ctx, s4.turn!.id)!.failures).toBe(1);
  });

  test("a done turn that leaves a failed step still open is re-woken by the tick", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);
    const turn = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    // Turn ends done without resolving the failed step (no step.skip/retry).
    await settleTurn(ctx, turn!.id, { outcome: "done" });
    expect(openWakeups(ctx, r.id)).toHaveLength(0);
    // Real tick recreates/reopens the wake-up under the same key (and may start the next turn).
    await advanceRuns({ ...ctx, now: READY + COALESCE_WINDOW_S }, spawn, deps, {
      spawn, plannerEligible: () => true,
    });
    const reopened = workflowDatabase(ctx).query<{ cause: string; ref: string; done_at: number | null }, [string, string]>(
      "SELECT cause, ref, done_at FROM workflow_wakeups WHERE run_id = ? AND cause = 'step_failed' AND ref = ?",
    ).all(r.id, `${r.id}/one#1`);
    expect(reopened.length).toBeGreaterThanOrEqual(1);
    // Either still open, or claimed by a new live turn — not left permanently done.
    const stuckDone = reopened.every(w => w.done_at !== null)
      && workflowDatabase(ctx).query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM workflow_turns WHERE run_id = ? AND status IN ('starting','running')",
      ).get(r.id)!.n === 0;
    expect(stuckDone).toBe(false);
  });

  // I5: two done turns that leave the same cause open must block before turn N+1.
  test("two done turns leaving the same wake open block before the next turn", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);

    const t1 = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    expect(t1).not.toBeNull();
    await settleTurn({ ...ctx, now: READY + 1 }, t1!.id, { outcome: "done" });

    // Recreate the same open cause (tick would do this) and start a second turn.
    const wakeRef = `${r.id}/one#1`;
    addWakeup(workflowDatabase(ctx), {
      runId: r.id, cause: "step_failed", ref: wakeRef, createdAt: READY - COALESCE_WINDOW_S,
    });
    const t2 = await startTurn({ ...ctx, now: READY + 60 }, r.id, {
      spawn, plannerEligible: () => true,
    });
    expect(t2).not.toBeNull();
    await settleTurn({ ...ctx, now: READY + 61 }, t2!.id, { outcome: "done" });

    const blocked = getRun(ctx, r.id)!;
    expect(blocked.orchestratorState).toBe("blocked");
    expect(blocked.reason).toMatch(/unresolved/i);
    const attn = deriveWorkflowAttention(ctx).find(i =>
      i.id.includes(r.id) && (i.severity === "blocked" || i.kind === "orchestrator_failed" || /unresolved/i.test(i.detail ?? "")),
    );
    expect(attn).toBeTruthy();

    addWakeup(workflowDatabase(ctx), {
      runId: r.id, cause: "step_failed", ref: wakeRef, createdAt: READY,
    });
    const t3 = await startTurn({ ...ctx, now: READY + 200 }, r.id, {
      spawn, plannerEligible: () => true,
    });
    expect(t3).toBeNull();
  });

  // G4: retry_orchestrator after an unresolved-wake block must not conflict on rev
  // (clearAttentionAt / spent patch must not leave the final updateRun stale).
  test("retry_orchestrator clears unresolved-wake block via attention params", async () => {
    const { callOp } = await import("../src/api/ops");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);

    const t1 = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    await settleTurn({ ...ctx, now: READY + 1 }, t1!.id, { outcome: "done" });
    const wakeRef = `${r.id}/one#1`;
    addWakeup(workflowDatabase(ctx), {
      runId: r.id, cause: "step_failed", ref: wakeRef, createdAt: READY - COALESCE_WINDOW_S,
    });
    const t2 = await startTurn({ ...ctx, now: READY + 60 }, r.id, {
      spawn, plannerEligible: () => true,
    });
    await settleTurn({ ...ctx, now: READY + 61 }, t2!.id, { outcome: "done" });

    const blocked = getRun(ctx, r.id)!;
    expect(blocked.orchestratorState).toBe("blocked");
    expect(blocked.reason).toMatch(/unresolved/i);
    const attn = deriveWorkflowAttention(ctx).find(i => i.id.includes(r.id));
    expect(attn).toBeTruthy();
    const retry = attn!.actions.find(a => a.op === "run.retry_orchestrator");
    expect(retry).toBeTruthy();
    const cleared = await callOp(ctx, "run.retry_orchestrator", retry!.params) as {
      orchestratorState?: string | null; reason?: string | null;
    };
    expect(cleared.orchestratorState).toBe("idle");
    expect(cleared.reason ?? null).toBeNull();
    expect(getRun(ctx, r.id)!.orchestratorState).toBe("idle");
  });

  test("planner at limit does not count as failure; wakes when eligible", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b" });
    addWakeup(workflowDatabase(ctx), { runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW - COALESCE_WINDOW_S });
    let eligible = false;
    const spawn: SpawnRunner = () => 1;
    const first = await startTurn(ctx, run.id, { spawn, plannerEligible: () => eligible });
    expect(first).toBeNull();
    expect(getRun(ctx, run.id)!.orchestratorState).toBe("retrying");
    expect(getRun(ctx, run.id)!.reason).toMatch(/planner at limit/);

    eligible = true;
    await advanceRuns({ ...ctx, now: NOW + 3601 }, spawn, undefined, { spawn, plannerEligible: () => eligible });
    const turns = workflowDatabase(ctx).query<{ status: string; failures: number }, [string]>(
      "SELECT status, failures FROM workflow_turns WHERE run_id = ?",
    ).all(run.id);
    expect(turns.some(t => t.status === "running")).toBe(true);
    expect(turns.every(t => t.failures === 0)).toBe(true);
  });

  test("a limit-ended turn sets retrying via the real tick and does not spend budget", async () => {
    const { markExhausted } = await import("../src/usage/reactive");
    const { parseSpent, serializeBudget, serializeSpent } = await import("../src/workflow/budget");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, {
      workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b",
      budget: serializeBudget({ orchestratorTurns: 10, messageTurns: 5 }),
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW - COALESCE_WINDOW_S,
    });
    const spawn: SpawnRunner = () => 1;
    // Production path: no plannerEligible injection — default pacing from exhausted marks.
    const turn = await startTurn(ctx, run.id, { spawn });
    expect(turn).not.toBeNull();
    expect(parseSpent(getRun(ctx, run.id)!.spent).orchestratorTurns).toBe(1);
    updateTask(ctx, turn!.taskId!, t => { t.state = "limit"; });
    markExhausted(ctx, "claude-code", NOW + 7200);
    // Settle through the real orchestrate phase (no eligibility stub).
    await advanceRuns({ ...ctx, now: NOW + 1 }, spawn);
    expect(getTurn(ctx, turn!.id)!.status).toBe("failed");
    expect(getTurn(ctx, turn!.id)!.failures).toBe(0);
    expect(parseSpent(getRun(ctx, run.id)!.spent).orchestratorTurns).toBe(0);
    expect(getRun(ctx, run.id)!.orchestratorState).toBe("retrying");
    expect(getRun(ctx, run.id)!.nextWakeAt).toBe(NOW + 7200);
    // Another tick before reset must not start a new turn (would burn budget in a loop).
    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW - COALESCE_WINDOW_S,
    });
    await advanceRuns({ ...ctx, now: NOW + 10 }, spawn);
    const live = workflowDatabase(ctx).query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM workflow_turns WHERE run_id = ? AND status IN ('starting','running')",
    ).get(run.id)!.n;
    expect(live).toBe(0);
    expect(parseSpent(getRun(ctx, run.id)!.spent).orchestratorTurns).toBe(0);
  });

  test("quota-exhausted planner evidence (no markExhausted) holds the run without a turn", async () => {
    // Real product evidence path: usage/eligibility store, not limitObservation marks
    // and not an injected plannerEligible stub (CT-11 live gap).
    const { loadStrategy } = await import("../src/config/strategy");
    const { accountEvidenceScope, mergeEvidence, readEvidence } = await import("../src/core/evidence");
    const { emptyEvidence, evidenceFact } = await import("../src/engine/evidence");
    const { evaluateEligibility } = await import("../src/engine/eligibility");
    const { executorExclusion } = await import("../src/executors/availability");
    const { parseSpent, serializeBudget, serializeSpent } = await import("../src/workflow/budget");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const s = loadStrategy(ctx);
    const account = s.accounts[s.planner.account]!;
    const scope = accountEvidenceScope(account, s.hosts);
    const runner = s.runners["claude-code"]!;
    const resetsAt = NOW + 7200;
    const facts = emptyEvidence();
    facts.budget.push(evidenceFact(scope, "session-log", NOW - 60, null, "quota_observed", {
      name: "5h", usedPct: 100, resetsAt, lengthS: 18000, paced: false,
    }));
    await mergeEvidence(ctx, scope, facts);
    // Same local guard the runner uses for budget refusals.
    expect(executorExclusion(ctx, s, "claude-code")).toBe("exhausted");
    const decision = evaluateEligibility({
      now: ctx.now,
      scope: { ...scope, runner: runner.id, model: runner.model ?? "default", host: runner.host ?? "local" },
      usage: account.usage, allowPaid: account.allowPaid,
      evidence: readEvidence(ctx, scope).evidence, restrictions: [],
    });
    expect(decision.state).toBe("ineligible");
    expect(decision.reasons.some(r => r.code === "budget_exhausted")).toBe(true);
    expect(decision.validUntil).toBeGreaterThan(NOW);

    const run = insertRun(ctx, {
      workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b",
      budget: serializeBudget({ orchestratorTurns: 10, messageTurns: 5 }),
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW - COALESCE_WINDOW_S,
    });
    let launched = 0;
    const spawn: SpawnRunner = () => { launched++; return 1; };
    await advanceRuns(ctx, spawn);
    expect(launched).toBe(0);
    expect(parseSpent(getRun(ctx, run.id)!.spent).orchestratorTurns).toBe(0);
    const turns = workflowDatabase(ctx).query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM workflow_turns WHERE run_id = ?",
    ).get(run.id)!.n;
    expect(turns).toBe(0);
    expect(getRun(ctx, run.id)!.orchestratorState).toBe("retrying");
    expect(getRun(ctx, run.id)!.reason).toMatch(/^planner at limit until /);
    expect(getRun(ctx, run.id)!.nextWakeAt).toBe(decision.validUntil);

    // Eligible again via fresh lower usage after the eligibility reset (same evidence channel).
    const afterReset = decision.validUntil! + 1;
    const recovered = emptyEvidence();
    recovered.budget.push(evidenceFact(scope, "session-log", afterReset - 10, null, "quota_observed", {
      name: "5h", usedPct: 10, resetsAt: afterReset + 10_000, lengthS: 18000, paced: false,
    }));
    await mergeEvidence({ ...ctx, now: afterReset }, scope, recovered);
    expect(executorExclusion({ ...ctx, now: afterReset }, s, "claude-code")).toBeUndefined();
    await advanceRuns({ ...ctx, now: afterReset }, spawn);
    expect(launched).toBe(1);
    expect(parseSpent(getRun(ctx, run.id)!.spent).orchestratorTurns).toBe(1);
    expect(getRun(ctx, run.id)!.orchestratorState).toBe("turn");
  });

  test("runner budget-refusal report settles as planner-at-limit, not a counted failure", async () => {
    const { parseSpent, serializeBudget, serializeSpent } = await import("../src/workflow/budget");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, {
      workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b",
      budget: serializeBudget({ orchestratorTurns: 10, messageTurns: 5 }),
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW - COALESCE_WINDOW_S,
    });
    // Eligible at pre-launch check time (skipDefaultPacing); refusal arrives after launch.
    const turn = await startTurn(ctx, run.id, { spawn: () => 1, skipDefaultPacing: true });
    expect(turn).not.toBeNull();
    expect(parseSpent(getRun(ctx, run.id)!.spent).orchestratorTurns).toBe(1);
    const report = 'pacer runner error: requested executor "claude-code" is unavailable (Budget exhausted; paid overflow is off (allow_paid: false))';
    updateTask(ctx, turn!.taskId!, t => {
      t.state = "failed";
      t.result = { status: "failed", executor: null, model: null, files: "", report, backend: "direct" };
    });
    await advanceRuns({ ...ctx, now: NOW + 1 }, () => 1, undefined, { skipDefaultPacing: true });
    expect(getTurn(ctx, turn!.id)!.status).toBe("failed");
    expect(getTurn(ctx, turn!.id)!.failures).toBe(0);
    expect(parseSpent(getRun(ctx, run.id)!.spent).orchestratorTurns).toBe(0);
    expect(getRun(ctx, run.id)!.orchestratorState).toBe("retrying");
    expect(getRun(ctx, run.id)!.reason).toMatch(/^planner at limit until /);
    expect(getRun(ctx, run.id)!.reason).not.toMatch(/planner failed/);
  });

  test("ordinary runner refusal still counts toward D1 backoff", async () => {
    const { parseSpent, serializeBudget, serializeSpent } = await import("../src/workflow/budget");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, {
      workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b",
      budget: serializeBudget({ orchestratorTurns: 10, messageTurns: 5 }),
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW - COALESCE_WINDOW_S,
    });
    const turn = await startTurn(ctx, run.id, { spawn: () => 1, skipDefaultPacing: true });
    expect(turn).not.toBeNull();
    const report = 'pacer runner error: requested executor "claude-code" is unavailable (not installed)';
    updateTask(ctx, turn!.taskId!, t => {
      t.state = "failed";
      t.result = { status: "failed", executor: null, model: null, files: "", report, backend: "direct" };
    });
    await advanceRuns({ ...ctx, now: NOW + 1 }, () => 1, undefined, { skipDefaultPacing: true });
    expect(getTurn(ctx, turn!.id)!.failures).toBe(1);
    expect(getRun(ctx, run.id)!.orchestratorState).toBe("retrying");
    expect(getRun(ctx, run.id)!.reason).toMatch(/planner failed 1/);
    expect(getRun(ctx, run.id)!.nextWakeAt).toBe(NOW + 1 + 60);
    // Counted failures keep the budget spend (unlike planner-at-limit refunds).
    expect(parseSpent(getRun(ctx, run.id)!.spent).orchestratorTurns).toBe(1);

    for (let i = 0; i < 3; i++) {
      const at = NOW + 1000 + i * 10_000;
      addWakeup(workflowDatabase(ctx), {
        runId: run.id, cause: "step_failed", ref: `one#${i + 2}`, createdAt: at - COALESCE_WINDOW_S,
      });
      const t = await startTurn({ ...ctx, now: at }, run.id, { spawn: () => 1, skipDefaultPacing: true });
      expect(t, `ordinary fail ${i + 2}`).not.toBeNull();
      updateTask(ctx, t!.taskId!, task => {
        task.state = "failed";
        task.result = {
          status: "failed", executor: null, model: null, files: "",
          report: 'pacer runner error: requested executor "claude-code" is unavailable (not installed)',
          backend: "direct",
        };
      });
      await advanceRuns({ ...ctx, now: at + 1 }, () => 1, undefined, { skipDefaultPacing: true });
      expect(getTurn(ctx, t!.id)!.failures).toBe(i + 2);
    }
    expect(getRun(ctx, run.id)!.orchestratorState).toBe("blocked");
    expect(getRun(ctx, run.id)!.reason).toMatch(/planner failed 4/);
  });

  test("an overdue turn is stopped and its grant no longer verifies", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b" });
    addWakeup(workflowDatabase(ctx), { runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW - COALESCE_WINDOW_S });
    const spawn: SpawnRunner = () => 1;
    const turn = await startTurn(ctx, run.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    const grant = issueRunGrant(ctx, { runId: run.id, turnId: turn!.id, deadline: turn!.deadline });
    expect(verifyRunGrant(ctx, grant)).not.toBeNull();

    const stopped: string[] = [];
    await advanceRuns({ ...ctx, now: turn!.deadline + 1 }, spawn, undefined, {
      spawn,
      plannerEligible: () => true,
      stopTask: (_c, id) => { stopped.push(id); updateTask(_c, id, t => { t.state = "stopped"; }); },
    });
    expect(getTurn(ctx, turn!.id)!.status).toBe("failed");
    expect(getTurn(ctx, turn!.id)!.reason).toBe("deadline");
    expect(verifyRunGrant({ ...ctx, now: turn!.deadline + 1 }, grant)).toBeNull();
    expect(turn!.taskId).toBeDefined();
    expect(stopped).toContain(turn!.taskId!);
  });

  test("a starting turn with no task_id is settled by the tick; partial/needs_input settle too", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b" });
    insertTurn(ctx, {
      id: "turn_starting",
      runId: run.id,
      planner: "claude-code",
      status: "starting",
      startedAt: NOW,
      deadline: NOW + 1200,
    });
    await advanceRuns(ctx, () => 1);
    expect(getTurn(ctx, "turn_starting")!.status).toBe("failed");
    expect(getTurn(ctx, "turn_starting")!.reason).toBe("missing task");

    const task = createTask(ctx, {
      brief: { goal: "orch", repo: run.repo },
      kind: "orchestrate",
      requestedExecutor: null,
      timeoutS: 600,
    });
    updateTask(ctx, task.id, t => { t.state = "needs_input"; });
    const turn2 = insertTurn(ctx, {
      id: "turn_needs",
      runId: run.id,
      planner: "claude-code",
      status: "running",
      startedAt: NOW,
      deadline: NOW + 1200,
      taskId: task.id,
    });
    await advanceRuns(ctx, () => 1);
    expect(getTurn(ctx, turn2.id)!.status).toBe("failed");
    expect(getTurn(ctx, turn2.id)!.reason).toBe("needs_input");
  });

  test("launchTaskRunner failure fails the turn instead of hanging until the deadline", async () => {
    const { parseSpent } = await import("../src/workflow/budget");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b" });
    addWakeup(workflowDatabase(ctx), {
      runId: run.id, cause: "step_failed", ref: "one#1", createdAt: NOW - COALESCE_WINDOW_S,
    });
    const spawn: SpawnRunner = () => { throw new Error("spawn boom"); };
    const turn = await startTurn(ctx, run.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    expect(turn!.status).toBe("failed");
    expect(turn!.reason).toMatch(/launch failed/);
    expect(turn!.failures).toBe(1);
    expect(openWakeups(ctx, run.id).length).toBeGreaterThanOrEqual(1);
    // Launch never ran: refund the counted turn once; do not treat as planner-at-limit.
    const after = getRun(ctx, run.id)!;
    expect(after.orchestratorState).toBe("retrying");
    expect(after.reason).toMatch(/planner failed 1/);
    expect(after.nextWakeAt).toBe(NOW + 60);
    expect(after.reason).not.toMatch(/planner at limit/i);
    expect(parseSpent(after.spent).orchestratorTurns).toBe(0);

    // N consecutive launch failures → blocked + orchestrator_failed attention (D1: 4th).
    for (let i = 0; i < 3; i++) {
      const at = NOW + 1000 + i * 10_000;
      addWakeup(workflowDatabase(ctx), {
        runId: run.id, cause: "step_failed", ref: `one#${i + 2}`, createdAt: at - COALESCE_WINDOW_S,
      });
      const t = await startTurn({ ...ctx, now: at }, run.id, { spawn, plannerEligible: () => true });
      expect(t, `launch fail ${i + 2}`).not.toBeNull();
      expect(t!.failures).toBe(i + 2);
    }
    const blocked = getRun(ctx, run.id)!;
    expect(blocked.orchestratorState).toBe("blocked");
    expect(blocked.reason).toMatch(/planner failed 4/);
    const attn = getOrchestratorAttention(ctx, run.id);
    expect(attn?.kind).toBe("orchestrator_failed");
    expect(parseSpent(blocked.spent).orchestratorTurns).toBe(0);
  });

  test("restart with a running turn and no process fails it and revokes its grant", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b" });
    const task = createTask(ctx, {
      brief: { goal: "orch", repo: run.repo },
      kind: "orchestrate",
      requestedExecutor: null,
      timeoutS: 600,
    });
    // Terminal non-settleable state (not queued/done): process is gone.
    updateTask(ctx, task.id, t => { t.state = "failed"; });
    const turn = insertTurn(ctx, {
      id: "turn_orphan",
      runId: run.id,
      planner: "claude-code",
      status: "running",
      startedAt: NOW,
      deadline: NOW + 1200,
      taskId: task.id,
    });
    const bearer = issueRunGrant(ctx, { runId: run.id, turnId: turn.id, deadline: NOW + 1200 });
    expect(verifyRunGrant(ctx, bearer)).not.toBeNull();
    await recoverOrphanTurns(ctx);
    expect(getTurn(ctx, turn.id)!.status).toBe("failed");
    expect(verifyRunGrant(ctx, bearer)).toBeNull();
  });

  test("recoverOrphanTurns leaves queued and done orchestrator tasks alone", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    for (const state of ["queued", "done"] as const) {
      const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b" });
      const task = createTask(ctx, {
        brief: { goal: `orch-${state}`, repo: run.repo },
        kind: "orchestrate",
        requestedExecutor: null,
        timeoutS: 600,
      });
      updateTask(ctx, task.id, t => { t.state = state; });
      const turn = insertTurn(ctx, {
        id: `turn_${state}`,
        runId: run.id,
        planner: "claude-code",
        status: "running",
        startedAt: NOW,
        deadline: NOW + 1200,
        taskId: task.id,
      });
      await recoverOrphanTurns(ctx);
      expect(getTurn(ctx, turn.id)!.status).toBe("running");
    }
  });

  test("a deleted wake-up is recreated by the needsOrchestrator scan", async () => {
    const ctx = fakeCtx({ now: NOW });
    const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b" });
    insertStep(ctx, { runId: run.id, stepId: "one", attempt: 1, status: "failed", taskId: "t-x" });
    workflowDatabase(ctx).query(
      "UPDATE workflow_steps SET error = ? WHERE run_id = ?",
    ).run("failed", run.id);
    expect(openWakeups(ctx, run.id)).toHaveLength(0);
    await advanceRuns(ctx, () => 1, undefined, { spawn: () => 1, plannerEligible: () => false });
    expect(openWakeups(ctx, run.id).some(w => w.cause === "step_failed" && w.ref === `${run.id}/one#1`)).toBe(true);
  });

  test("operations completed before the deadline stay applied after the turn fails", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    // Simulate a prior orchestrator action: a step result recorded before the turn dies.
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    recordStepResult(ctx, s1.taskId!, { kept: true });
    addWakeup(workflowDatabase(ctx), { runId: r.id, cause: "step_failed", ref: "other#1", createdAt: NOW - COALESCE_WINDOW_S });
    const turn = await startTurn(ctx, r.id, { spawn, plannerEligible: () => true });
    await settleTurn(ctx, turn!.id, { outcome: "failed", reason: "deadline" });
    expect(stepsOfRun(ctx, r.id)[0]!.result).toEqual({ kept: true });
  });
});

describe("Task 6: orchestrator steps and choose_workflow", () => {
  const orchWf: WorkflowDef = {
    id: "t/orch-step",
    version: 1,
    steps: {
      plan: { type: "agent", role: "orchestrator", prompt: "Plan: {{brief}}" },
      done: { type: "end" },
    },
    edges: [{ from: "plan", to: "done" }],
    entry: "plan",
  };

  const childWf: WorkflowDef = {
    id: "t/child",
    version: 1,
    steps: {
      work: { type: "agent", kind: "research", prompt: "Work" },
      done: { type: "end" },
    },
    edges: [{ from: "work", to: "done" }],
    entry: "work",
  };

  const chooseWf: WorkflowDef = {
    id: "t/choose",
    version: 1,
    steps: {
      pick: { type: "choose_workflow", from: ["t/child"] },
      done: { type: "end" },
    },
    edges: [{ from: "pick", to: "done" }],
    entry: "pick",
  };

  test("an orchestrator step produces no new executor task; retry is another turn", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, orchWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-step", repo: tmpDir(), brief: "B" }, spawn, deps);
    const steps = stepsOfRun(ctx, r.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.stepId).toBe("plan");
    expect(steps[0]!.taskId).toBe(getRun(ctx, r.id)!.orchestratorTaskId);
    const all = listTasksWhere(ctx, { all: true });
    expect(all.filter(t => t.kind !== "orchestrate")).toHaveLength(0);
    expect(all.filter(t => t.kind === "orchestrate")).toHaveLength(1);
    // Ordinary snapshot / task.list paths hide the engine-owned orchestrate task (D2.12).
    const { snapshotTasks } = await import("../src/api/read-model/tasks");
    expect(snapshotTasks(ctx, all).every(t => t.kind !== "orchestrate")).toBe(true);
    expect(openWakeups(ctx, r.id).some(w => w.cause === "orchestrator_step")).toBe(true);

    // Retry: another attempt, same orchestrator task, another wake-up/turn.
    const orchId = getRun(ctx, r.id)!.orchestratorTaskId!;
    updateTask(ctx, orchId, t => { t.state = "failed"; });
    await onTaskSettled(ctx, orchId, spawn, deps);
    const again = await startStep(ctx, getRun(ctx, r.id)!, orchWf, "plan", undefined, { deps, spawn });
    expect(again.attempt).toBeGreaterThan(1);
    expect(again.taskId).toBe(orchId);
    expect(listTasksWhere(ctx, { all: true }).filter(t => t.kind === "orchestrate")).toHaveLength(1);
  });

  // I4 + N3: startTurn rebuilds the brief with buildTurnPrompt; step/choose text must
  // appear as instructions OUTSIDE data fences (substituted values stay fenced inside).
  test("turn prompt includes open orchestrator_step prompt and choose_workflow from list", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const distinctive = "UNIQUE_ORCH_STEP_PROMPT_xyz42";
    const orchDistinct: WorkflowDef = {
      id: "t/orch-prompt",
      version: 1,
      steps: {
        plan: { type: "agent", role: "orchestrator", prompt: `${distinctive}: {{brief}}` },
        done: { type: "end" },
      },
      edges: [{ from: "plan", to: "done" }],
      entry: "plan",
    };
    addDefinition(ctx, orchDistinct, "source");
    addDefinition(ctx, chooseWf, "source");
    addDefinition(ctx, childWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;

    const orchRun = await startRun(ctx, {
      workflow: "t/orch-prompt", repo: tmpDir(), brief: "brief-body",
    }, spawn, deps);
    // Stash is present before the turn, then startTurn rebuilds the brief.
    const before = readTask(ctx, getRun(ctx, orchRun.id)!.orchestratorTaskId!)!.brief.goal;
    expect(before).toContain(distinctive);
    expect(before).toContain("brief-body");
    const turn = await startTurn({ ...ctx, now: READY }, orchRun.id, {
      spawn, plannerEligible: () => true,
    });
    expect(turn).not.toBeNull();
    const after = readTask(ctx, turn!.taskId!)!.brief.goal;
    expect(after).toContain(distinctive);
    expect(after).toContain("brief-body");
    expect(after).toMatch(/orchestrator.step|step prompt|plan#/i);
    // N3: must not wrap the step prompt in an outer --- data … orchestrator step prompt --- fence.
    expect(after).not.toMatch(/--- data [a-f0-9]+ orchestrator step prompt/);
    expect(after).toMatch(/step to perform|pacer step result/i);

    const chooseRun = await startRun(ctx, {
      workflow: "t/choose", repo: tmpDir(), brief: "pick-me",
    }, spawn, deps);
    const chooseTurn = await startTurn({ ...ctx, now: READY }, chooseRun.id, {
      spawn, plannerEligible: () => true,
    });
    expect(chooseTurn).not.toBeNull();
    const choosePrompt = readTask(ctx, chooseTurn!.taskId!)!.brief.goal;
    expect(choosePrompt).toContain("t/child");
    expect(choosePrompt).toMatch(/choose_workflow|from/i);
    expect(choosePrompt).not.toMatch(/--- data [a-f0-9]+ choose_workflow/);
    expect(choosePrompt).toMatch(/step to perform|pacer run choose/i);
  });

  test("choose_workflow refuses a workflow outside from", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chooseWf, "source");
    addDefinition(ctx, childWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/choose", repo: tmpDir(), brief: "B" }, spawn, deps);
    await expect(chooseWorkflow(ctx, {
      runId: r.id,
      stepId: "pick",
      workflow: "t/orch-step",
      reason: "nope",
    }, spawn, deps)).rejects.toThrow(/outside the allowed from list/);
  });

  test("the child run's end settles the parent choose step; child has no own orchestrator", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chooseWf, "source");
    addDefinition(ctx, childWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/choose", repo: tmpDir(), brief: "B" }, spawn, deps);
    const child = await chooseWorkflow(ctx, {
      runId: r.id,
      stepId: "pick",
      workflow: "t/child",
      reason: "fits",
    }, spawn, deps);
    expect(child.parentRunId).toBe(r.id);
    expect(child.parentStep).toBe("pick");
    expect(child.orchestratorTaskId).toBe(getRun(ctx, r.id)!.orchestratorTaskId);
    // Child must not start its own turn.
    addWakeup(workflowDatabase(ctx), { runId: child.id, cause: "step_failed", ref: "x#1", createdAt: NOW - COALESCE_WINDOW_S });
    expect(await startTurn(ctx, child.id, { spawn, plannerEligible: () => true })).toBeNull();

    const work = stepsOfRun(ctx, child.id).find(s => s.stepId === "work")!;
    recordStepResult(ctx, work.taskId!, { ok: true });
    settle(ctx, work.taskId!);
    await onTaskSettled(ctx, work.taskId!, spawn, deps);
    expect(getRun(ctx, child.id)!.status).toBe("done");
    const pick = stepsOfRun(ctx, r.id).find(s => s.stepId === "pick")!;
    expect(pick.status).toBe("done");
    expect(pick.result).toMatchObject({ workflow: "t/child", reason: "fits" });
    expect(getRun(ctx, r.id)!.status).toBe("done");
  });

  test("step.skip under a run grant resolves a failed step and advances through the engine", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);
    expect(openWakeups(ctx, r.id).some(w => w.cause === "step_failed")).toBe(true);
    const turn = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    const grant = issueRunGrant(ctx, { runId: r.id, turnId: turn!.id, deadline: READY + 600 });
    const { callOp } = await import("../src/api/ops");
    const updated = await callOp(
      { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" } },
      "step.skip",
      { id: r.id, step: "one" },
      { spawnRunner: spawn, delegate: deps.delegate },
    ) as { status: string };
    expect(stepsOfRun(ctx, r.id).find(s => s.stepId === "one" && s.attempt === 1)!.status).toBe("done");
    expect(stepsOfRun(ctx, r.id).find(s => s.stepId === "one" && s.attempt === 1)!.result).toEqual({ skipped: true });
    // Successor started; failure wake-up closed.
    expect(stepsOfRun(ctx, r.id).some(s => s.stepId === "two" && s.status === "running")).toBe(true);
    expect(openWakeups(ctx, r.id).filter(w => w.cause === "step_failed")).toHaveLength(0);
    expect(updated.status).toBeTruthy();
  });

  test("step.retry under a run grant starts a new attempt of a failed step", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);
    const turn = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    const grant = issueRunGrant(ctx, { runId: r.id, turnId: turn!.id, deadline: READY + 600 });
    const { callOp } = await import("../src/api/ops");
    await callOp(
      { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" } },
      "step.retry",
      { id: r.id, step: "one" },
      { spawnRunner: spawn, delegate: deps.delegate },
    );
    const ones = stepsOfRun(ctx, r.id).filter(s => s.stepId === "one");
    expect(ones.some(s => s.attempt === 1 && s.status === "failed")).toBe(true);
    expect(ones.some(s => s.attempt === 2 && (s.status === "running" || s.status === "waiting"))).toBe(true);
  });

  test("a failed step inside a choose_workflow child wakes the root through the tick", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chooseWf, "source");
    addDefinition(ctx, childWf, "source");
    const { deps } = fakeDeps();
    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => { launches.push(id); return 1; };
    const r = await startRun(ctx, { workflow: "t/choose", repo: tmpDir(), brief: "B" }, spawn, deps);
    // Age/clear the choose wake-up so the failure wake-up is what starts the turn.
    workflowDatabase(ctx).query("DELETE FROM workflow_wakeups WHERE run_id = ?").run(r.id);
    const child = await chooseWorkflow(ctx, {
      runId: r.id, stepId: "pick", workflow: "t/child", reason: "fits",
    }, spawn, deps);
    workflowDatabase(ctx).query("DELETE FROM workflow_wakeups WHERE run_id = ?").run(r.id);
    const work = stepsOfRun(ctx, child.id).find(s => s.stepId === "work")!;
    settle(ctx, work.taskId!, "failed");
    await onTaskSettled(ctx, work.taskId!, spawn, deps);
    // Wake-up lands on the root, never the child.
    expect(openWakeups(ctx, child.id)).toHaveLength(0);
    expect(openWakeups(ctx, r.id)).toEqual([
      expect.objectContaining({ cause: "step_failed", ref: `${child.id}/work#1` }),
    ]);
    const orch: OrchestratorDeps = { spawn, plannerEligible: () => true };
    const out = await advanceRuns({ ...ctx, now: READY }, spawn, deps, orch);
    expect(out.orchestrated).toBeGreaterThanOrEqual(1);
    expect(await startTurn(ctx, child.id, orch)).toBeNull();
    const turns = workflowDatabase(ctx).query<{ run_id: string; status: string }, [string]>(
      "SELECT run_id, status FROM workflow_turns WHERE run_id = ?",
    ).all(r.id);
    expect(turns).toEqual([{ run_id: r.id, status: "running" }]);
    expect(launches.length).toBeGreaterThanOrEqual(1);
  });

  // N1: after a correct choose, pick stays waiting with childRunId until the child
  // ends; needsOrchestrator / wakeCauseStillOpen must treat that as closed so the
  // tick does not re-wake or allow a duplicate child (and then I5 "unresolved wake").
  test("after choose, tick must not re-wake or start a second child", async () => {
    const { needsOrchestrator } = await import("../src/workflow/wakeups");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chooseWf, "source");
    addDefinition(ctx, childWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/choose", repo: tmpDir(), brief: "B" }, spawn, deps);

    const turn = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    const child = await chooseWorkflow(ctx, {
      runId: r.id, stepId: "pick", workflow: "t/child", reason: "fits",
    }, spawn, deps);
    await settleTurn(ctx, turn!.id, { outcome: "done" });

    await expect(chooseWorkflow(ctx, {
      runId: r.id, stepId: "pick", workflow: "t/child", reason: "again",
    }, spawn, deps)).rejects.toThrow(/conflict/i);

    for (let i = 0; i < 5; i++) {
      await advanceRuns({ ...ctx, now: READY + COALESCE_WINDOW_S + i * 60 }, spawn, deps, {
        spawn, plannerEligible: () => true,
      });
    }

    const children = workflowDatabase(ctx).query<{ id: string }, [string]>(
      "SELECT id FROM workflow_runs WHERE parent_run_id = ?",
    ).all(r.id);
    expect(children).toEqual([{ id: child.id }]);

    const turns = workflowDatabase(ctx).query<{ id: string; status: string }, [string]>(
      "SELECT id, status FROM workflow_turns WHERE run_id = ?",
    ).all(r.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe("done");
    expect(needsOrchestrator(ctx).filter(n =>
      n.runId === r.id && n.cause === "orchestrator_step" && n.ref.includes("/pick#"),
    )).toHaveLength(0);
    expect(getRun(ctx, r.id)!.orchestratorState).not.toBe("blocked");
  });
});

describe("round-2 B1: real startTurn → _run hop", () => {
  test("launch env lets cli.main(_run) enter; agent env (not _run env) holds the grant", async () => {
    const { main } = await import("../src/cli");
    const { runTask } = await import("../src/tasks/runner");
    const { executorEnv } = await import("../src/exec/process");
    const { validateStrategy } = await import("../src/config/strategy");
    const { eligibility } = await import("./fixtures/eligibility");

    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    let launchEnv: Record<string, string | undefined> = {};
    const spawn: SpawnRunner = (c) => {
      launchEnv = { ...c.env };
      return 1;
    };
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);
    const turn = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    const taskId = turn!.taskId!;

    // Preferred: _run is an ordinary runner process — no grant/role on the launch env.
    expect(launchEnv.PACER_RUN_GRANT).toBeUndefined();
    expect(launchEnv.PACER_ROLE).not.toBe("orchestrator");

    // Real CLI entry with exactly the env startTurn builds must not hit the allow-list.
    const { cliDeps } = await import("../src/cli");
    let enteredRun = false;
    const prevRun = cliDeps.runTask;
    cliDeps.runTask = async (c, id) => {
      enteredRun = true;
      return readTask(c, id) ?? readTask(ctx, taskId)!;
    };
    let cliResult: { code: number; out: string; err: string };
    try {
      cliResult = await main(["_run", taskId], { ...ctx, env: { ...ctx.env, ...launchEnv } });
    } finally {
      cliDeps.runTask = prevRun;
    }
    expect(cliResult.err).not.toMatch(/orchestrator role only allows/);
    expect(enteredRun).toBe(true);

    // Agent execution env (via the real runner path) holds the grant and role.
    const strategy = validateStrategy({
      planner: "claude-code",
      providers: { "claude-code": {} },
    }, "/x");
    let agentEnv: Record<string, string | undefined> = {};
    let runEnv: Record<string, string | undefined> = {};
    await runTask({ ...ctx, env: { ...ctx.env, ...launchEnv } }, taskId, {
      loadStrategy: () => strategy,
      computeStatus: async () => ({
        generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal",
        disabled: false, paused: null, modeHold: null, calendarPace: true,
        providers: [{
          id: "claude-code", eligibility: eligibility(), usage: "quota", windows: [],
          binding: null, verdict: "ON_PACE", installed: true, stale: false,
        }],
        executors: { ranked: [{ id: "claude-code", score: 1, verdict: "OK", reason: "" }], excluded: [] },
      }),
      runAttempt: async (c) => {
        runEnv = { ...c.env };
        agentEnv = executorEnv(c.env, { HOME: ctx.home }, taskId, [], {
          runGrant: typeof c.env.PACER_RUN_GRANT === "string" ? c.env.PACER_RUN_GRANT : undefined,
        });
        return {
          exec: { code: 0, stdout: "ok", stderr: "", timedOut: false },
          report: "ok",
          attempt: {
            executor: "claude-code", model: null, startedAt: 1, endedAt: 2,
            exitCode: 0, timedOut: false, limitHit: false, log: "/tmp/x.log",
          },
        };
      },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(runEnv.PACER_ROLE).toBe("orchestrator");
    expect(runEnv.PACER_RUN_GRANT).toMatch(/^prg_[0-9a-f]{64}$/);
    expect(agentEnv.PACER_ROLE).toBe("orchestrator");
    expect(agentEnv.PACER_RUN_GRANT).toBe(runEnv.PACER_RUN_GRANT);
    expect(verifyRunGrant(ctx, agentEnv.PACER_RUN_GRANT!)).toEqual({ runId: r.id, turnId: turn!.id });
    // Launch/_run env still must not carry the bearer.
    expect(launchEnv.PACER_RUN_GRANT).toBeUndefined();
  });
});

describe("round-2 I1+I7: stopLiveTurnsForRun scope and process stop", () => {
  test("child terminal does not stop the root turn; root terminal stops the orchestrator task", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const childDef: WorkflowDef = {
      id: "t/child-i1", version: 1,
      steps: { work: { type: "agent", kind: "research", prompt: "W" }, done: { type: "end" } },
      edges: [{ from: "work", to: "done" }], entry: "work",
    };
    const chooseDef: WorkflowDef = {
      id: "t/choose-i1", version: 1,
      steps: { pick: { type: "choose_workflow", from: ["t/child-i1"] }, done: { type: "end" } },
      edges: [{ from: "pick", to: "done" }], entry: "pick",
    };
    addDefinition(ctx, chooseDef, "source");
    addDefinition(ctx, childDef, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/choose-i1", repo: tmpDir(), brief: "B" }, spawn, deps);
    workflowDatabase(ctx).query("DELETE FROM workflow_wakeups WHERE run_id = ?").run(r.id);
    const child = await chooseWorkflow(ctx, {
      runId: r.id, stepId: "pick", workflow: "t/child-i1", reason: "fits",
    }, spawn, deps);
    addWakeup(workflowDatabase(ctx), {
      runId: r.id, cause: "message", ref: "m-i1", createdAt: NOW - COALESCE_WINDOW_S,
    });
    const turn = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    expect(turn?.status).toBe("running");
    expect(turn?.taskId).toBeTruthy();
    updateTask(ctx, turn!.taskId!, t => { t.state = "running"; });
    const grant = issueRunGrant(ctx, { runId: r.id, turnId: turn!.id, deadline: READY + 600 });

    // Child failing must not stop the root's live turn (I1); parent choose wakes instead.
    const work = stepsOfRun(ctx, child.id).find(s => s.stepId === "work")!;
    settle(ctx, work.taskId!, "failed");
    await onTaskSettled(ctx, work.taskId!, spawn, deps);
    expect(["failed", "waiting", "running"]).toContain(getRun(ctx, child.id)!.status);
    // Force the child terminal without completing the parent choose successfully.
    const { failRun } = await import("../src/workflow/engine");
    if (!["done", "failed", "stopped"].includes(getRun(ctx, child.id)!.status)) {
      await failRun(ctx, child.id, "test fail", undefined, deps);
    }
    expect(getRun(ctx, child.id)!.status).toBe("failed");
    expect(getTurn(ctx, turn!.id)!.status).toBe("running");
    expect(verifyRunGrant(ctx, grant)).not.toBeNull();

    // Root terminal stops the turn and the orchestrator task process (I7).
    const { stopRun } = await import("../src/workflow/engine");
    await stopRun(ctx, r.id, getRun(ctx, r.id)!.rev, deps);
    expect(getTurn(ctx, turn!.id)!.status).toBe("stopped");
    expect(readTask(ctx, turn!.taskId!)!.state).toBe("stopped");
  });
});

describe("round-2 B4: step.retry must not livelock the tick", () => {
  test("after step.retry, ticks do not reopen step_failed or start another turn while the new attempt runs", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);
    const turn = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    const grant = issueRunGrant(ctx, { runId: r.id, turnId: turn!.id, deadline: READY + 600 });
    const { callOp } = await import("../src/api/ops");
    await callOp(
      { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" } },
      "step.retry",
      { id: r.id, step: "one" },
      { spawnRunner: spawn, delegate: deps.delegate },
    );
    await settleTurn(ctx, turn!.id, { outcome: "done" });
    const ones = stepsOfRun(ctx, r.id).filter(s => s.stepId === "one");
    expect(ones.some(s => s.attempt === 2 && (s.status === "running" || s.status === "waiting"))).toBe(true);

    const { needsOrchestrator } = await import("../src/workflow/wakeups");
    // While attempt 2 runs, the failed attempt 1 must not reappear as an open decision.
    expect(needsOrchestrator(ctx).filter(n => n.runId === r.id && n.cause === "step_failed")).toHaveLength(0);
    expect(openWakeups(ctx, r.id).filter(w => w.cause === "step_failed")).toHaveLength(0);

    const turnsBefore = workflowDatabase(ctx).query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM workflow_turns WHERE run_id = ?",
    ).get(r.id)!.n;
    const orch: OrchestratorDeps = { spawn, plannerEligible: () => true };
    for (let i = 0; i < 5; i++) {
      await advanceRuns({ ...ctx, now: READY + 1000 + i * 60 }, spawn, deps, orch);
    }
    const turnsAfter = workflowDatabase(ctx).query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM workflow_turns WHERE run_id = ?",
    ).get(r.id)!.n;
    expect(turnsAfter).toBe(turnsBefore);
    const live = workflowDatabase(ctx).query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM workflow_turns WHERE run_id = ? AND status IN ('starting','running')",
    ).get(r.id)!.n;
    expect(live).toBe(0);
    // Still only one retry attempt in flight — no concurrent attempt 3.
    expect(stepsOfRun(ctx, r.id).filter(s => s.stepId === "one" && s.attempt >= 3)).toHaveLength(0);
  });
});

describe("round-2 B3: step workers must not inherit the run grant", () => {
  test("step.retry and run.decide launch step workers without prg_/orchestrator role", async () => {
    const { launchTaskRunner } = await import("../src/tasks/api");
    const { executorEnv } = await import("../src/exec/process");
    const { callOp } = await import("../src/api/ops");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const autoWf: WorkflowDef = {
      id: "t/auto-b3",
      version: 1,
      steps: {
        ask: { type: "human", question: { text: "Go?", kind: "approve_revise" }, decision: "auto" },
        work: { type: "agent", kind: "research", prompt: "Work" },
        done: { type: "end" },
      },
      edges: [
        { from: "ask", to: "work", when: "result.answer == 'approve'" },
        { from: "ask", to: "done", when: "result.answer == 'revise'" },
        { from: "work", to: "done" },
      ],
      entry: "ask",
    };
    addDefinition(ctx, chain, "source");
    addDefinition(ctx, autoWf, "source");

    /** Delegate that uses the real launchTaskRunner hop (not a createTask-only stub). */
    function launchingDeps(launches: { taskId: string; env: Record<string, string | undefined> }[]) {
      const byRequest = new Map<string, TaskRecord>();
      const delegate: EngineDeps["delegate"] = async (c, input, spawn) => {
        const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
        if (prior) return readTask(c, prior.id) ?? prior;
        const task = createTask(c, {
          brief: input.brief,
          kind: input.kind ?? null,
          requestedExecutor: null,
          timeoutS: 600,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        });
        if (input.requestId) byRequest.set(input.requestId, task);
        if (spawn) {
          launchTaskRunner(c, task.id, (lc, id) => {
            launches.push({ taskId: id, env: { ...lc.env } });
            return spawn(lc, id);
          });
        }
        return readTask(c, task.id)!;
      };
      return {
        deps: {
          delegate,
          stopTask: (c: Ctx, id: string) => updateTask(c, id, t => { t.state = "stopped"; }),
        } satisfies EngineDeps,
      };
    }

    // --- step.retry under a run grant ---
    const retryLaunches: { taskId: string; env: Record<string, string | undefined> }[] = [];
    const { deps: retryDeps } = launchingDeps(retryLaunches);
    const retrySpawn: SpawnRunner = () => 1;
    const r1 = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, retrySpawn, retryDeps);
    const s1 = stepsOfRun(ctx, r1.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, retrySpawn, retryDeps);
    const turn1 = await startTurn({ ...ctx, now: READY }, r1.id, { spawn: retrySpawn, plannerEligible: () => true });
    const grant1 = issueRunGrant(ctx, { runId: r1.id, turnId: turn1!.id, deadline: READY + 600 });
    retryLaunches.length = 0;
    await callOp(
      { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant1, PACER_ROLE: "orchestrator" } },
      "step.retry",
      { id: r1.id, step: "one" },
      { spawnRunner: retrySpawn, delegate: retryDeps.delegate },
    );
    expect(retryLaunches.length).toBeGreaterThanOrEqual(1);
    for (const launch of retryLaunches) {
      expect(launch.env.PACER_RUN_GRANT).toBeUndefined();
      expect(launch.env.PACER_ROLE).not.toBe("orchestrator");
      const agent = executorEnv(launch.env, { HOME: ctx.home }, launch.taskId);
      expect(agent.PACER_ROLE).toBe("executor");
      expect(agent.PACER_RUN_GRANT).toBeUndefined();
    }

    // --- run.decide under a run grant starts the next agent step ---
    const decideLaunches: { taskId: string; env: Record<string, string | undefined> }[] = [];
    const { deps: decideDeps } = launchingDeps(decideLaunches);
    const decideSpawn: SpawnRunner = () => 1;
    let r2 = await startRun(ctx, { workflow: "t/auto-b3", repo: tmpDir(), brief: "B" }, decideSpawn, decideDeps);
    r2 = updateRun(ctx, r2.id, r2.rev, { auto: true });
    expect(stepsOfRun(ctx, r2.id).find(s => s.stepId === "ask")?.status).toBe("waiting");
    const turn2 = insertTurn(ctx, {
      id: "turn_b3_decide", runId: r2.id, planner: "claude-code", status: "running",
      startedAt: READY, deadline: READY + 600, taskId: createTask(ctx, {
        brief: { goal: "orch", repo: tmpDir() }, kind: "orchestrate", requestedExecutor: null, timeoutS: 600,
      }).id,
    });
    const grant2 = issueRunGrant(ctx, { runId: r2.id, turnId: turn2.id, deadline: READY + 600 });
    decideLaunches.length = 0;
    await callOp(
      { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant2, PACER_ROLE: "orchestrator" } },
      "run.decide",
      { id: r2.id, step: "ask", choice: "approve", reason: "ok" },
      { spawnRunner: decideSpawn, delegate: decideDeps.delegate },
    );
    const workLaunches = decideLaunches.filter(l => readTask(ctx, l.taskId)?.kind !== "orchestrate");
    expect(workLaunches.length).toBeGreaterThanOrEqual(1);
    for (const launch of workLaunches) {
      expect(launch.env.PACER_RUN_GRANT).toBeUndefined();
      expect(launch.env.PACER_ROLE).not.toBe("orchestrator");
      const agent = executorEnv(launch.env, { HOME: ctx.home }, launch.taskId);
      expect(agent.PACER_ROLE).toBe("executor");
      expect(agent.PACER_RUN_GRANT).toBeUndefined();
    }
  });
});

describe("round-2 B2: orchestrator review/stop are scoped", () => {
  test("main(stop|review) on a foreign task is refused; --send-back/--retry-on refused", async () => {
    const { main } = await import("../src/cli");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/orch-chain", version: 1, repo: tmpDir(), brief: "b" });
    const orchTask = createTask(ctx, {
      brief: { goal: "orchestrate", repo: tmpDir() }, kind: "orchestrate", requestedExecutor: null, timeoutS: 600,
    });
    insertTurn(ctx, {
      id: "turn_b2", runId: run.id, planner: "claude-code", status: "running",
      startedAt: NOW, deadline: NOW + 600, taskId: orchTask.id,
    });
    const grant = issueRunGrant(ctx, { runId: run.id, turnId: "turn_b2", deadline: NOW + 600 });
    const foreign = createTask(ctx, {
      brief: { goal: "foreign", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 600,
    });
    updateTask(ctx, foreign.id, t => { t.state = "running"; });
    const foreignDone = createTask(ctx, {
      brief: { goal: "foreign-done", repo: tmpDir() }, kind: null, requestedExecutor: "codex", timeoutS: 600,
    });
    updateTask(ctx, foreignDone.id, t => {
      t.state = "done";
      t.attempts = [{
        executor: "codex", model: null, startedAt: NOW, endedAt: NOW + 1,
        exitCode: 0, timedOut: false, limitHit: false, log: "/tmp/x.log",
      }];
      t.result = { status: "done", executor: "codex", model: null, files: "", report: "ok", backend: "direct" };
    });

    const orchCtx: Ctx = {
      ...ctx,
      env: {
        ...ctx.env,
        PACER_ROLE: "orchestrator",
        PACER_RUN_GRANT: grant,
        PACER_API: "inprocess",
      },
    };

    const stop = await main(["stop", foreign.id], orchCtx);
    expect(stop.code).toBe(2);
    expect(stop.err).toMatch(/not_allowed|outside this run grant/i);
    expect(readTask(ctx, foreign.id)!.state).toBe("running");

    const review = await main(["review", foreignDone.id, "--accept"], orchCtx);
    expect(review.code).toBe(2);
    expect(review.err).toMatch(/not_allowed|outside this run grant/i);
    expect(readTask(ctx, foreignDone.id)!.review).toBeUndefined();

    const sendBack = await main(["review", foreignDone.id, "--send-back", "--note", "retry"], orchCtx);
    expect(sendBack.code).toBe(2);
    expect(sendBack.err).toMatch(/orchestrator|not_allowed|delegat/i);

    const retryOn = await main(["review", foreignDone.id, "--retry-on", "codex"], orchCtx);
    expect(retryOn.code).toBe(2);
    expect(retryOn.err).toMatch(/orchestrator|not_allowed|delegat/i);
  });
});

describe("round-3 N6: production launch opt-in for run grant", () => {
  test("planOwnedLaunch puts orchestrator grant only on orchestrate tasks", async () => {
    const { planOwnedLaunch } = await import("../src/plugins/executor-launch-plan");
    const { loadStrategy } = await import("../src/config/strategy");
    const { validateExecution } = await import("../src/config/execution");
    const { chmodSync, mkdirSync: mkdir, writeFileSync: write } = await import("node:fs");
    const bin = tmpDir();
    write(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "claude"), 0o755);
    const ctx = fakeCtx({ now: NOW, env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } });
    writePlanner(ctx);
    mkdir(ctx.pacerHome, { recursive: true });
    const strategy = loadStrategy(ctx);
    const grant = `prg_${"b".repeat(64)}`;
    const repo = tmpDir();
    const orch = createTask(ctx, {
      brief: { goal: "orch", repo }, kind: "orchestrate", requestedExecutor: null, timeoutS: 600,
    });
    const plain = createTask(ctx, {
      brief: { goal: "plain", repo }, kind: "research", requestedExecutor: null, timeoutS: 600,
    });
    const withGrant = {
      ...ctx,
      env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" },
    };
    const cfg = { ...strategy.providers["claude-code"]!, session: "headless" as const };
    const orchPlan = await planOwnedLaunch(withGrant, {
      cfg, task: orch, execution: validateExecution(undefined), placement: "current",
      workdir: repo, dir: tmpDir(), brief: "orch brief", repoRoots: [repo],
    });
    expect("refused" in orchPlan).toBe(false);
    if ("refused" in orchPlan) throw new Error(orchPlan.refused);
    expect(orchPlan.env.PACER_ROLE).toBe("orchestrator");
    expect(orchPlan.env.PACER_RUN_GRANT).toBe(grant);

    const plainPlan = await planOwnedLaunch(withGrant, {
      cfg, task: plain, execution: validateExecution(undefined), placement: "current",
      workdir: repo, dir: tmpDir(), brief: "plain brief", repoRoots: [repo],
    });
    expect("refused" in plainPlan).toBe(false);
    if ("refused" in plainPlan) throw new Error(plainPlan.refused);
    expect(plainPlan.env.PACER_ROLE).not.toBe("orchestrator");
    expect(plainPlan.env.PACER_RUN_GRANT).toBeUndefined();
  });

  test("runnerProcess scrubs run grant and orchestrator role for every task", async () => {
    const { runnerProcess } = await import("../src/tasks/api");
    const { existsSync, readFileSync } = await import("node:fs");
    const ctx = fakeCtx({ now: NOW });
    const orch = createTask(ctx, {
      brief: { goal: "orch", repo: tmpDir() }, kind: "orchestrate", requestedExecutor: null, timeoutS: 600,
    });
    const plain = createTask(ctx, {
      brief: { goal: "plain", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 600,
    });
    const grant = `prg_${"c".repeat(64)}`;
    for (const task of [orch, plain]) {
      const out = join(tmpDir(), `env-${task.id}`);
      const env = {
        ...ctx.env,
        OUT: out,
        PACER_RUN_GRANT: grant,
        PACER_ROLE: "orchestrator",
      };
      runnerProcess([
        "/bin/sh", "-c",
        'printf "%s|%s" "${PACER_RUN_GRANT-unset}" "${PACER_ROLE-unset}" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"',
        "sh",
      ])({ ...ctx, env }, task.id);
      for (let i = 0; i < 100 && !existsSync(out); i++) await Bun.sleep(20);
      expect(readFileSync(out, "utf8"), task.kind ?? "null").toBe("unset|unset");
    }
  });
});

describe("round-4 G7: real runAttemptAdmitted opt-in", () => {
  // Deleting the opt-in in direct.ts ~613 must fail this test (N6/G7).
  test("runAttemptAdmitted opts in run grant only for orchestrate tasks", async () => {
    const { runAttempt } = await import("../src/exec/direct");
    const { validateStrategy } = await import("../src/config/strategy");
    const { chmodSync, existsSync, mkdirSync: mkdir, readFileSync, writeFileSync: write } = await import("node:fs");
    const bin = tmpDir();
    const dumpOrch = join(tmpDir(), "g7-orch-env");
    const dumpPlain = join(tmpDir(), "g7-plain-env");
    // Dump path is chosen per call via $PACER_HOME/g7-dump-path (set before runAttempt).
    write(join(bin, "claude"), `#!/bin/sh
DUMP=$(cat "$PACER_HOME/g7-dump-path")
/usr/bin/env -0 > "$DUMP"
exit 0
`);
    chmodSync(join(bin, "claude"), 0o755);
    const repo = tmpDir();
    await Bun.$`git init ${repo}`.quiet();
    write(join(repo, "README"), "x");
    await Bun.$`git -C ${repo} add README && git -C ${repo} -c user.email=t@t -c user.name=t commit -m init`.quiet();
    const ctx = fakeCtx({
      now: NOW,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: process.env.HOME,
        PACER_LOGIN_ENV: "off",
      },
    });
    writePlanner(ctx);
    mkdir(ctx.pacerHome, { recursive: true });
    write(join(ctx.pacerHome, "strategy.yaml"),
      "planner: claude-code\nproviders: {claude-code: {}}\nexecution: {backend: direct, launch_mode: headless, worktree: never}\n");
    const cfg = {
      ...validateStrategy({
        planner: "claude-code",
        providers: { "claude-code": { session: "headless" } },
        execution: { backend: "direct", launch_mode: "headless", worktree: "never" },
      }, "/x").providers["claude-code"]!,
      session: "headless" as const,
    };
    const grant = `prg_${"e".repeat(64)}`;
    const parseDump = (path: string) => {
      expect(existsSync(path), `missing ${path}`).toBe(true);
      return Object.fromEntries(
        readFileSync(path, "utf8").split("\0").filter(Boolean).map(e => {
          const i = e.indexOf("=");
          return [e.slice(0, i), e.slice(i + 1)];
        }),
      );
    };

    write(join(ctx.pacerHome, "g7-dump-path"), dumpOrch);
    const orch = createTask(ctx, {
      brief: { goal: "orch-g7", repo }, kind: "orchestrate", requestedExecutor: "claude-code", timeoutS: 30,
    });
    updateTask(ctx, orch.id, t => { t.state = "running"; });
    const orchOut = await runAttempt(
      { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" } },
      cfg,
      readTask(ctx, orch.id)!,
    );
    expect(orchOut.exec.code, orchOut.report).toBe(0);
    const orchEnv = parseDump(dumpOrch);
    expect(orchEnv.PACER_ROLE).toBe("orchestrator");
    expect(orchEnv.PACER_RUN_GRANT).toBe(grant);
    updateTask(ctx, orch.id, t => { t.state = "done"; delete t.run; });

    write(join(ctx.pacerHome, "g7-dump-path"), dumpPlain);
    const plainRepo = tmpDir();
    await Bun.$`git init ${plainRepo}`.quiet();
    write(join(plainRepo, "README"), "x");
    await Bun.$`git -C ${plainRepo} add README && git -C ${plainRepo} -c user.email=t@t -c user.name=t commit -m init`.quiet();
    const plain = createTask(ctx, {
      brief: { goal: "plain-g7", repo: plainRepo }, kind: "research", requestedExecutor: "claude-code", timeoutS: 30,
    });
    updateTask(ctx, plain.id, t => { t.state = "running"; });
    const plainOut = await runAttempt(
      { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" } },
      cfg,
      readTask(ctx, plain.id)!,
    );
    expect(plainOut.exec.code, plainOut.report).toBe(0);
    const plainEnv = parseDump(dumpPlain);
    expect(plainEnv.PACER_ROLE).not.toBe("orchestrator");
    expect(plainEnv.PACER_RUN_GRANT).toBeUndefined();
  });
});

describe("round-3 N5: skip/retry ignore superseded failed attempts", () => {
  test("skip after retry conflicts while attempt 2 runs; retry after done conflicts", async () => {
    const { callOp } = await import("../src/api/ops");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);
    const turn = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    const grant = issueRunGrant(ctx, { runId: r.id, turnId: turn!.id, deadline: READY + 600 });
    const orch = {
      ...ctx,
      env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" },
    };

    await callOp(orch, "step.retry", { id: r.id, step: "one" }, { spawnRunner: spawn, delegate: deps.delegate });
    const afterRetry = stepsOfRun(ctx, r.id).filter(s => s.stepId === "one");
    expect(afterRetry.some(s => s.attempt === 1 && s.status === "failed")).toBe(true);
    expect(afterRetry.some(s => s.attempt === 2 && (s.status === "running" || s.status === "waiting"))).toBe(true);

    await expect(callOp(orch, "step.skip", { id: r.id, step: "one" }, {
      spawnRunner: spawn, delegate: deps.delegate,
    })).rejects.toThrow(/conflict/i);
    // Attempt 2 still running; attempt 1 not marked done; no successor from a stale skip.
    expect(stepsOfRun(ctx, r.id).find(s => s.stepId === "one" && s.attempt === 1)!.status).toBe("failed");
    expect(stepsOfRun(ctx, r.id).some(s => s.stepId === "two")).toBe(false);

    // Finish attempt 2 successfully, then retry must conflict (no open failed latest).
    const a2 = stepsOfRun(ctx, r.id).find(s => s.stepId === "one" && s.attempt === 2)!;
    recordStepResult(ctx, a2.taskId!, { ok: true });
    settle(ctx, a2.taskId!);
    await onTaskSettled(ctx, a2.taskId!, spawn, deps);
    await expect(callOp(orch, "step.retry", { id: r.id, step: "one" }, {
      spawnRunner: spawn, delegate: deps.delegate,
    })).rejects.toThrow(/conflict/i);
  });
});

describe("round-3 N4: wake refs and prompts carry owning runId", () => {
  test("child step id colliding with root includes runId; prompt lists child steps", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const rootWf: WorkflowDef = {
      id: "t/n4-root",
      version: 1,
      steps: {
        work: { type: "agent", kind: "research", prompt: "Root work" },
        pick: { type: "choose_workflow", from: ["t/n4-child"] },
        done: { type: "end" },
      },
      edges: [
        { from: "work", to: "pick" },
        { from: "pick", to: "done" },
      ],
      entry: "work",
    };
    const childWf: WorkflowDef = {
      id: "t/n4-child",
      version: 1,
      steps: {
        work: { type: "agent", kind: "research", prompt: "Child work" },
        done: { type: "end" },
      },
      edges: [{ from: "work", to: "done" }],
      entry: "work",
    };
    addDefinition(ctx, rootWf, "source");
    addDefinition(ctx, childWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/n4-root", repo: tmpDir(), brief: "B" }, spawn, deps);
    const rootWork = stepsOfRun(ctx, r.id).find(s => s.stepId === "work")!;
    recordStepResult(ctx, rootWork.taskId!, { ok: true });
    settle(ctx, rootWork.taskId!);
    await onTaskSettled(ctx, rootWork.taskId!, spawn, deps);

    const child = await chooseWorkflow(ctx, {
      runId: r.id, stepId: "pick", workflow: "t/n4-child", reason: "fits",
    }, spawn, deps);
    workflowDatabase(ctx).query("DELETE FROM workflow_wakeups WHERE run_id = ?").run(r.id);
    const childWork = stepsOfRun(ctx, child.id).find(s => s.stepId === "work")!;
    settle(ctx, childWork.taskId!, "failed");
    await onTaskSettled(ctx, childWork.taskId!, spawn, deps);

    const open = openWakeups(ctx, r.id);
    expect(open).toEqual([
      expect.objectContaining({ cause: "step_failed", ref: `${child.id}/work#1` }),
    ]);
    expect(open[0]!.ref).not.toBe("work#1");
    expect(open[0]!.ref).toContain(child.id);

    const turn = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    const goal = readTask(ctx, turn!.taskId!)!.brief.goal;
    expect(goal).toContain(`run=${child.id}`);
    expect(goal).toContain(childWork.taskId!);
    // Root's done work step and child's failed work both listed (no dedupe by step id alone).
    expect(goal).toMatch(new RegExp(`work#1 run=${r.id}`));
    expect(goal).toMatch(new RegExp(`work#1 run=${child.id}`));
  });
});

describe("round-3 N2: orchestrator prompt and CLI/MCP commands", () => {
  test("buildTurnPrompt names commands and open steps with taskId and runId", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);
    const turn = await startTurn({ ...ctx, now: READY }, r.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    const goal = readTask(ctx, turn!.taskId!)!.brief.goal;
    expect(goal).toContain("pacer run choose");
    expect(goal).toContain("pacer step skip");
    expect(goal).toContain("pacer step retry");
    expect(goal).toContain("pacer run decide");
    expect(goal).toMatch(new RegExp(`one#1.*run=${r.id}`));
    expect(goal).toMatch(/task=/);
    expect(goal).toContain(s1.taskId!);
  });

  test("buildPrompt for orchestrate via real call site omits executor and pacer ask", async () => {
    const { buildPrompt } = await import("../src/exec/prompt");
    const p = buildPrompt(
      { goal: "wake: step_failed one#1", repo: tmpDir() },
      "t-orch-n2",
      false,
      { kind: "orchestrate" },
    );
    expect(p.toLowerCase()).not.toMatch(/\bexecutor\b/);
    expect(p).not.toContain("pacer ask");
    expect(p).toContain("run choose");
    expect(p).toContain("step skip");
  });

  test("CLI run choose / step skip|retry work for own-run grant and refuse foreign", async () => {
    const { main } = await import("../src/cli");
    const { startServer } = await import("../src/serve/http");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chain, "source");
    const chooseWf: WorkflowDef = {
      id: "t/n2-choose",
      version: 1,
      steps: {
        pick: { type: "choose_workflow", from: ["t/orch-chain"] },
        done: { type: "end" },
      },
      edges: [{ from: "pick", to: "done" }],
      entry: "pick",
    };
    addDefinition(ctx, chooseWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;

    const own = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, own.id)[0]!;
    settle(ctx, s1.taskId!, "failed");
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);
    const turn = await startTurn({ ...ctx, now: READY }, own.id, { spawn, plannerEligible: () => true });

    const foreign = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "F" }, spawn, deps);
    const fs1 = stepsOfRun(ctx, foreign.id)[0]!;
    settle(ctx, fs1.taskId!, "failed");
    await onTaskSettled(ctx, fs1.taskId!, spawn, deps);

    const server = startServer(() => ({ ...ctx, now: READY }), {
      port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false,
      opDeps: { spawnRunner: spawn, delegate: deps.delegate },
    });
    try {
      await Bun.sleep(20);
      // Issue grants after serve start so start-up recovery cannot revoke them.
      const grant = issueRunGrant(ctx, { runId: own.id, turnId: turn!.id, deadline: READY + 600 });
      const orchCtx: Ctx = {
        ...ctx,
        env: {
          ...ctx.env,
          PACER_ROLE: "orchestrator",
          PACER_RUN_GRANT: grant,
          PACER_PORT: String(server.port),
        },
      };

      const skipOwn = await main(["step", "skip", own.id, "one"], orchCtx);
      expect(skipOwn.code).toBe(0);
      expect(stepsOfRun(ctx, own.id).find(s => s.stepId === "one" && s.attempt === 1)!.status).toBe("done");

      const foreignSkip = await main(["step", "skip", foreign.id, "one"], orchCtx);
      expect(foreignSkip.code).toBe(2);
      expect(foreignSkip.err).toMatch(/not_allowed|outside this run grant|run grant|forbidden/i);

      const retryRun = await startRun(ctx, { workflow: "t/orch-chain", repo: tmpDir(), brief: "R" }, spawn, deps);
      const rs1 = stepsOfRun(ctx, retryRun.id)[0]!;
      settle(ctx, rs1.taskId!, "failed");
      await onTaskSettled(ctx, rs1.taskId!, spawn, deps);
      const rTurn = await startTurn({ ...ctx, now: READY + 10 }, retryRun.id, { spawn, plannerEligible: () => true });
      const rGrant = issueRunGrant(ctx, { runId: retryRun.id, turnId: rTurn!.id, deadline: READY + 700 });
      const retryCtx: Ctx = {
        ...ctx,
        env: {
          ...ctx.env,
          PACER_ROLE: "orchestrator",
          PACER_RUN_GRANT: rGrant,
          PACER_PORT: String(server.port),
        },
      };
      const retryOwn = await main(["step", "retry", retryRun.id, "one"], retryCtx);
      expect(retryOwn.code).toBe(0);
      expect(stepsOfRun(ctx, retryRun.id).some(s => s.stepId === "one" && s.attempt === 2)).toBe(true);

      const chooseRun = await startRun(ctx, { workflow: "t/n2-choose", repo: tmpDir(), brief: "C" }, spawn, deps);
      const cTurn = await startTurn({ ...ctx, now: READY + 20 }, chooseRun.id, { spawn, plannerEligible: () => true });
      const cGrant = issueRunGrant(ctx, { runId: chooseRun.id, turnId: cTurn!.id, deadline: READY + 800 });
      const chooseCtx: Ctx = {
        ...ctx,
        env: {
          ...ctx.env,
          PACER_ROLE: "orchestrator",
          PACER_RUN_GRANT: cGrant,
          PACER_PORT: String(server.port),
        },
      };
      const choose = await main(
        ["run", "choose", chooseRun.id, "pick", "t/orch-chain", "--reason", "fits"],
        chooseCtx,
      );
      expect(choose.code).toBe(0);
      const children = workflowDatabase(ctx).query<{ id: string }, [string]>(
        "SELECT id FROM workflow_runs WHERE parent_run_id = ?",
      ).all(chooseRun.id);
      expect(children).toHaveLength(1);

      const foreignChoose = await main(
        ["run", "choose", foreign.id, "one", "t/orch-chain", "--reason", "nope"],
        chooseCtx,
      );
      expect(foreignChoose.code).toBe(2);
    } finally {
      await server.stop();
    }
  });

  test("MCP run-grant server registers step_skip and step_retry", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../src/mcp/server");
    const ctx = fakeCtx({ now: NOW, env: { PACER_RUN_GRANT: "prg_" + "a".repeat(64) } });
    const server = createMcpServer(() => ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(["step_skip", "step_retry", "run_choose"]));
    await client.close();
  });
});

describe("round-4 G1: open orchestrator blocks resolve via owning run", () => {
  // Child orch step must appear in the turn prompt after choose; pick with
  // childRunId must not reappear; colliding step ids must not overwrite.
  test("after choose, tick prompt shows child orch instruction not stale pick", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const rootWf: WorkflowDef = {
      id: "t/g1-root",
      version: 1,
      steps: {
        pick: { type: "choose_workflow", from: ["t/g1-child"] },
        work: { type: "agent", kind: "research", prompt: "ROOT-WORK-INSTRUCTION" },
        done: { type: "end" },
      },
      edges: [
        { from: "pick", to: "work" },
        { from: "work", to: "done" },
      ],
      entry: "pick",
    };
    const childWf: WorkflowDef = {
      id: "t/g1-child",
      version: 1,
      steps: {
        orch: { type: "agent", role: "orchestrator", prompt: "CHILD-ORCH-INSTRUCTION" },
        work: { type: "agent", kind: "research", prompt: "CHILD-WORK-INSTRUCTION" },
        done: { type: "end" },
      },
      edges: [
        { from: "orch", to: "work" },
        { from: "work", to: "done" },
      ],
      entry: "orch",
    };
    addDefinition(ctx, rootWf, "source");
    addDefinition(ctx, childWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/g1-root", repo: tmpDir(), brief: "B" }, spawn, deps);

    const chooseTurn = await startTurn({ ...ctx, now: READY }, r.id, {
      spawn, plannerEligible: () => true,
    });
    expect(chooseTurn).not.toBeNull();
    const child = await chooseWorkflow(ctx, {
      runId: r.id, stepId: "pick", workflow: "t/g1-child", reason: "fits",
    }, spawn, deps);
    await settleTurn(ctx, chooseTurn!.id, { outcome: "done" });

    const pick = stepsOfRun(ctx, r.id).find(s => s.stepId === "pick")!;
    expect(pick.status).toBe("waiting");
    expect((pick.result as { childRunId?: string }).childRunId).toBe(child.id);
    expect(stepsOfRun(ctx, child.id).some(s => s.stepId === "orch" && s.status === "running")).toBe(true);

    // Drive the next turn through the tick so open blocks go through startTurn.
    const out = await advanceRuns({ ...ctx, now: READY + COALESCE_WINDOW_S }, spawn, deps, {
      spawn, plannerEligible: () => true,
    });
    expect(out.orchestrated).toBeGreaterThanOrEqual(1);
    const orchTurn = liveTurn(ctx, r.id);
    expect(orchTurn).not.toBeNull();
    const open = openWakeups(ctx, r.id).length === 0
      ? [] // claimed by the live turn
      : openWakeups(ctx, r.id);
    const claimed = workflowDatabase(ctx).query<{ cause: string; ref: string }, [string, string]>(
      "SELECT cause, ref FROM workflow_wakeups WHERE run_id = ? AND turn_id = ?",
    ).all(r.id, orchTurn!.id);
    expect(claimed).toEqual([
      expect.objectContaining({ cause: "orchestrator_step", ref: `${child.id}/orch#1` }),
    ]);
    void open;

    const goal = readTask(ctx, orchTurn!.taskId!)!.brief.goal;
    expect(goal).toContain("CHILD-ORCH-INSTRUCTION");
    expect(goal).toMatch(new RegExp(`## Orchestrator step ${child.id}/orch#1`));
    expect(goal).not.toMatch(/## choose_workflow.*pick#/i);
    expect(goal).not.toContain(`## choose_workflow ${r.id}/pick#1`);
    expect(goal).not.toContain("## choose_workflow pick#1");
    // Command templates use an owning-run placeholder, not only the root id.
    expect(goal).toMatch(/pacer run choose <owningRunId>/);
    expect(goal).toMatch(/pacer step skip <owningRunId>/);
    // Collision: both runs have step id "work"; child orch must still resolve.
    expect(goal).toContain("CHILD-ORCH-INSTRUCTION");
    expect(goal).not.toContain("ROOT-WORK-INSTRUCTION");
  });
});
