// Round-5 N5-3 / N5-4: set_planner resets failures; non-launch startTurn failures count.
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeCrypto from "node:crypto";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { SpawnRunner } from "../src/tasks/api";
import { createTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, getRun, insertRun, stepsOfRun, updateRun, workflowDatabase,
} from "../src/workflow/store";
import { onTaskSettled, startRun, type EngineDeps } from "../src/workflow/engine";
import { enqueueWakeup, getTurn, liveTurn } from "../src/workflow/wakeups";
import { startTurn } from "../src/workflow/orchestrator";
import { COALESCE_WINDOW_S } from "../src/workflow/budget";
import { callOp } from "../src/api/ops";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;
const READY = NOW + COALESCE_WINDOW_S;

function writePlanner(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

function fakeDeps() {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: EngineDeps["delegate"] = async (ctx, input: DelegateInput) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return prior;
    const task = createTask(ctx, {
      brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return {
    deps: {
      delegate,
      stopTask: (ctx: Ctx, id: string) => updateTask(ctx, id, t => { t.state = "stopped"; }),
    } as EngineDeps,
  };
}

describe("round-5 N5-3: set_planner resets consecutive failures", () => {
  test("run.set_planner resets turn failures when unblocking", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    let run = insertRun(ctx, { workflow: "t/n53", version: 1, repo: tmpDir(), brief: "b" });
    run = updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "planner failed 4×",
    });
    workflowDatabase(ctx).query(
      "INSERT INTO workflow_turns(id, run_id, planner, status, started_at, deadline, ended_at, failures) VALUES (?, ?, ?, 'failed', ?, ?, ?, 3)",
    ).run("turn_n53", run.id, "claude-code", NOW - 10, NOW - 5, NOW - 1);
    expect(getTurn(ctx, "turn_n53")!.failures).toBe(3);

    await callOp(ctx, "run.set_planner", {
      id: run.id, planner: "codex", expect_rev: getRun(ctx, run.id)!.rev,
    });
    expect(getTurn(ctx, "turn_n53")!.failures).toBe(0);
    expect(getRun(ctx, run.id)!.orchestratorState).toBe("idle");
  });
});

describe("round-5 N5-4: non-launch startTurn failure counts via settleTurn", () => {
  test("persistent createTask failure counts 1,2,3 then blocks on the 4th", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const chain: WorkflowDef = {
      id: "t/n54", version: 1,
      steps: {
        one: { type: "agent", kind: "research", prompt: "One" },
        done: { type: "end" },
      },
      edges: [{ from: "one", to: "done" }],
      entry: "one",
    };
    addDefinition(ctx, chain, "s");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/n54", repo: tmpDir(), brief: "B" }, spawn, deps);
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    updateTask(ctx, s1.taskId!, t => { t.state = "failed"; });
    await onTaskSettled(ctx, s1.taskId!, spawn, deps);

    // Throw inside the post-claim body (prompt nonce) so the non-launch catch
    // runs — not the launchTaskRunner catch (N5-4).
    const realRandom = nodeCrypto.randomBytes.bind(nodeCrypto);
    let promptNonceCalls = 0;
    const spy = spyOn(nodeCrypto, "randomBytes").mockImplementation(((size: number) => {
      // newTurnId uses randomBytes(8) once per startTurn; the next call is the prompt nonce.
      if (size === 8) {
        promptNonceCalls++;
        // Odd calls = turn id; even = prompt nonce inside the try.
        if (promptNonceCalls % 2 === 0) throw new Error("prompt nonce boom");
      }
      return realRandom(size);
    }) as typeof nodeCrypto.randomBytes);

    try {
      for (let i = 0; i < 4; i++) {
        enqueueWakeup(ctx, {
          runId: r.id, cause: "step_failed", ref: `${r.id}/one#1`, createdAt: NOW - 100,
        });
        const cur = getRun(ctx, r.id)!;
        if (cur.orchestratorState === "retrying" || cur.nextWakeAt !== undefined) {
          updateRun(ctx, cur.id, cur.rev, {
            orchestratorState: "idle", nextWakeAt: null, reason: null,
          });
        }
        expect(liveTurn(ctx, r.id)).toBeNull();
        const turn = await startTurn({ ...ctx, now: READY + i * 1000 }, r.id, {
          spawn, plannerEligible: () => true, skipDefaultPacing: true,
        });
        expect(turn?.reason).toMatch(/prompt nonce boom|start failed/i);
      }
    } finally {
      spy.mockRestore();
    }

    const failed = workflowDatabase(ctx).query<{ failures: number }, [string]>(
      "SELECT failures FROM workflow_turns WHERE run_id = ? AND status = 'failed' ORDER BY started_at",
    ).all(r.id);
    const counts = failed.map(f => f.failures);
    // A-M3: exact 1,2,3 then blocked on the 4th (not a soft maxFailures >= 3).
    expect(counts).toEqual([1, 2, 3, 4]);
    expect(getRun(ctx, r.id)!.orchestratorState).toBe("blocked");
  });
});
