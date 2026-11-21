// Round-3 minors: concurrency, fail-closed, attribution, budget marker, M2.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { createTask, updateTask } from "../src/tasks/store";
import { getRun, insertRun, insertStep, updateRun, workflowDatabase } from "../src/workflow/store";
import { insertTurn, updateTurn } from "../src/workflow/wakeups";
import { issueRunGrant } from "../src/workflow/run-grant";
import { serializeSpent } from "../src/workflow/budget";
import { callOp } from "../src/api/ops";
import { CoreError } from "../src/core/errors";
import { authorizeWorkOperation } from "../src/core/work";
import { localHuman, callerParticipant } from "../src/messaging/participants";
import { isOrchestratorSession } from "../src/install/role";

const NOW = 1_700_000_000;

function writePlanner(ctx: Ctx) {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

describe("round-3 minors", () => {
  test("run.retry_orchestrator refuses a stale expect_rev before resetting failures", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
    updateRun(ctx, run.id, run.rev, { orchestratorState: "blocked", reason: "three failures" });
    insertTurn(ctx, {
      id: "turn_m_rev", runId: run.id, planner: "claude-code", status: "failed",
      startedAt: NOW, deadline: NOW + 1, failures: 3,
    });
    updateTurn(ctx, "turn_m_rev", { endedAt: NOW + 1 });
    const current = getRun(ctx, run.id)!;
    await expect(callOp(ctx, "run.retry_orchestrator", {
      id: run.id, expect_rev: current.rev - 1,
    })).rejects.toThrow(/conflict|rev/i);
    const failures = workflowDatabase(ctx).query<{ failures: number }, [string]>(
      "SELECT failures FROM workflow_turns WHERE id = ?",
    ).get("turn_m_rev")!.failures;
    expect(failures).toBe(3);
  });

  test("M1: orchestrator role without run grant fails closed", async () => {
    const ctx = fakeCtx({
      now: NOW,
      env: { PACER_ROLE: "orchestrator" },
    });
    expect(() => authorizeWorkOperation(ctx, "task.stop", { id: "t-x" })).toThrow(CoreError);
    expect(() => authorizeWorkOperation(ctx, "routing.status", {})).toThrow(/grant|orchestrator/i);

    const { connectClient } = await import("../src/api/client");
    await expect(connectClient(ctx, { protocol: 3, allowFallback: false }))
      .rejects.toThrow(/grant|orchestrator/i);

    const { createMcpServer } = await import("../src/mcp/server");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createMcpServer(() => ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(["run_grant_required"]);
    expect(names).not.toContain("delegate");
    expect(names).not.toContain("budget_status");
    await client.close();
  });

  test("M5: localHuman is undefined for orchestrator; callerParticipant is orchestrator", () => {
    const orch = fakeCtx({
      env: { PACER_ROLE: "orchestrator", PACER_RUN_GRANT: `prg_${"d".repeat(64)}` },
    });
    expect(isOrchestratorSession(orch)).toBe(true);
    expect(localHuman(orch, true)).toBeUndefined();
    expect(callerParticipant(orch).id).toBe("orchestrator");
  });

  test("budget block uses structured blockedBy marker, not reason substring", async () => {
    const ctx = fakeCtx({ now: NOW });
    const run = insertRun(ctx, {
      workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b",
      budget: JSON.stringify({ orchestrator_turns: 1, message_turns: 20 }),
      spent: JSON.stringify({ orchestrator_turns: 0, message_turns: 0 }),
    });
    const { countOrchestratorTurn, parseSpent: ps } = await import("../src/workflow/budget");
    countOrchestratorTurn(ctx, run.id);
    const blocked = getRun(ctx, run.id)!;
    expect(blocked.orchestratorState).toBe("blocked");
    expect(ps(blocked.spent).blockedBy).toBe("budget");

    updateRun(ctx, run.id, blocked.rev, {
      orchestratorState: "blocked",
      reason: "unresolved wake budget-check#1 after 2 done turns",
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    const { deriveWorkflowAttention } = await import("../src/workflow/attention");
    const item = deriveWorkflowAttention(ctx).find(i => i.id.includes(run.id));
    expect(item?.id.startsWith("budget_spent:")).toBe(false);
  });

  test("M2: run grant refuses task.review send_back and retry", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
    const stepTask = createTask(ctx, {
      brief: { goal: "s", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 60,
    });
    updateTask(ctx, stepTask.id, t => {
      t.state = "done";
      t.attempts = [{
        executor: "codex", model: null, startedAt: NOW, endedAt: NOW + 1,
        exitCode: 0, timedOut: false, limitHit: false, log: "/tmp/x.log",
      }];
      t.result = { status: "done", executor: "codex", model: null, files: "", report: "ok", backend: "direct" };
    });
    const rev = (await import("../src/tasks/store")).readTask(ctx, stepTask.id)!.rev;
    insertStep(ctx, { runId: run.id, stepId: "one", attempt: 1, taskId: stepTask.id, status: "done" });
    insertTurn(ctx, {
      id: "turn_m2", runId: run.id, planner: "claude-code", status: "running",
      startedAt: NOW, deadline: NOW + 600, taskId: stepTask.id,
    });
    const grant = issueRunGrant(ctx, { runId: run.id, turnId: "turn_m2", deadline: NOW + 600 });
    const orch = {
      ...ctx,
      env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator" },
    };
    await expect(callOp(orch, "task.review", {
      id: stepTask.id, verdict: "send_back", expect_rev: rev, note: "x",
    })).rejects.toThrow(/not_allowed|delegat|send_back|never delegate|orchestrator/i);
    await expect(callOp(orch, "task.review", {
      id: stepTask.id, verdict: "retry", expect_rev: rev, executor: "codex",
    })).rejects.toThrow(/not_allowed|delegat|retry|never delegate|orchestrator/i);
  });

  test("M4: orchestrator stop output uses the task id", async () => {
    const { main } = await import("../src/cli");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
    const orchTask = createTask(ctx, {
      brief: { goal: "o", repo: tmpDir() }, kind: "orchestrate", requestedExecutor: null, timeoutS: 60,
    });
    const stepTask = createTask(ctx, {
      brief: { goal: "s", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 60,
    });
    updateTask(ctx, stepTask.id, t => { t.state = "running"; });
    insertStep(ctx, { runId: run.id, stepId: "one", attempt: 1, taskId: stepTask.id, status: "running" });
    insertTurn(ctx, {
      id: "turn_m4", runId: run.id, planner: "claude-code", status: "running",
      startedAt: NOW, deadline: NOW + 600, taskId: orchTask.id,
    });
    const grant = issueRunGrant(ctx, { runId: run.id, turnId: "turn_m4", deadline: NOW + 600 });
    const out = await main(["stop", stepTask.id], {
      ...ctx,
      env: { ...ctx.env, PACER_ROLE: "orchestrator", PACER_RUN_GRANT: grant, PACER_API: "inprocess" },
    });
    expect(out.code).toBe(0);
    expect(out.out).toContain(stepTask.id);
    expect(out.out).not.toMatch(/^undefined /);
  });
});
