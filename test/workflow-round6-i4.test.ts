// Round-6 I4: set_planner must refuse a stale rev before resetting failures.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { getRun, insertRun, updateRun, workflowDatabase } from "../src/workflow/store";
import { insertTurn, updateTurn, getTurn } from "../src/workflow/wakeups";
import { callOp } from "../src/api/ops";

const NOW = 1_700_000_000;

function writePlanner(ctx: { pacerHome: string }): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

describe("round-6 I4: set_planner stale rev before failures reset", () => {
  test("stale expect_rev leaves failures unchanged and raises conflict", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    let run = insertRun(ctx, { workflow: "t/i4", version: 1, repo: tmpDir(), brief: "b" });
    run = updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "planner failed 4×",
    });
    insertTurn(ctx, {
      id: "turn_i4", runId: run.id, planner: "claude-code", status: "failed",
      startedAt: NOW, deadline: NOW + 1, failures: 3,
    });
    updateTurn(ctx, "turn_i4", { endedAt: NOW + 1 });
    expect(getTurn(ctx, "turn_i4")!.failures).toBe(3);

    const current = getRun(ctx, run.id)!;
    await expect(callOp(ctx, "run.set_planner", {
      id: run.id, planner: "codex", expect_rev: current.rev - 1,
    })).rejects.toThrow(/conflict|rev/i);

    expect(getTurn(ctx, "turn_i4")!.failures).toBe(3);
    const row = workflowDatabase(ctx).query<{ failures: number }, [string]>(
      "SELECT failures FROM workflow_turns WHERE id = ?",
    ).get("turn_i4")!;
    expect(row.failures).toBe(3);
  });
});
