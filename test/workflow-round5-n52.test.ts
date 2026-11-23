// Round-5 N5-2: attention stamp kinds match readers; clears reset since on new episodes.
import { describe, expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { getRun, insertRun, updateRun } from "../src/workflow/store";
import {
  clearAttentionAt, countMessageTurn, countOrchestratorTurn, parseSpent,
  serializeBudget, serializeSpent, stampAttentionAt,
} from "../src/workflow/budget";
import { deriveWorkflowAttention } from "../src/workflow/attention";
import { callOp } from "../src/api/ops";

const NOW = 1_700_000_000;

describe("round-5 N5-2: attention stamp kinds and clears", () => {
  test("80% warn stamps budget_warn; message spent stamps budget_msg_spent", () => {
    const ctx = fakeCtx({ now: NOW });
    let run = insertRun(ctx, { workflow: "t/n52", version: 1, repo: tmpDir(), brief: "b" });
    run = updateRun(ctx, run.id, run.rev, {
      budget: serializeBudget({ orchestratorTurns: 10, messageTurns: 10 }),
      spent: serializeSpent({ orchestratorTurns: 7, messageTurns: 0 }),
    });
    countOrchestratorTurn(ctx, run.id); // 8/10 → warn
    expect(parseSpent(getRun(ctx, run.id)!.spent).attentionAtByKind?.budget_warn).toBe(NOW);
    expect(parseSpent(getRun(ctx, run.id)!.spent).attentionAtByKind?.budget_spent).toBeUndefined();

    const ctx2 = { ...ctx, now: NOW + 5 };
    let r2 = getRun(ctx2, run.id)!;
    r2 = updateRun(ctx2, r2.id, r2.rev, {
      spent: serializeSpent({
        ...parseSpent(r2.spent),
        messageTurns: 9,
      }),
    });
    countMessageTurn(ctx2, r2.id); // 10/10 → msg spent
    expect(parseSpent(getRun(ctx2, r2.id)!.spent).attentionAtByKind?.budget_msg_spent).toBe(NOW + 5);
  });

  test("second orchestrator_failed episode after retry shows a NEW since", async () => {
    const ctx = fakeCtx({ now: NOW });
    let run = insertRun(ctx, {
      workflow: "t/n52-fail", version: 1, repo: tmpDir(), brief: "b",
    });
    run = updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "planner failed 4×",
      spent: serializeSpent({ orchestratorTurns: 1, messageTurns: 0 }),
    });
    stampAttentionAt(ctx, run.id, "orchestrator_failed");
    const first = parseSpent(getRun(ctx, run.id)!.spent).attentionAtByKind?.orchestrator_failed;
    expect(first).toBe(NOW);

    // retry clears the stamp so a later failure episode gets a fresh clock.
    await callOp(ctx, "run.retry_orchestrator", { id: run.id, expect_rev: getRun(ctx, run.id)!.rev });
    expect(parseSpent(getRun(ctx, run.id)!.spent).attentionAtByKind?.orchestrator_failed).toBeUndefined();

    const later = { ...ctx, now: NOW + 100 };
    let blocked = getRun(later, run.id)!;
    blocked = updateRun(later, blocked.id, blocked.rev, {
      orchestratorState: "blocked",
      reason: "planner failed 4×",
    });
    stampAttentionAt(later, blocked.id, "orchestrator_failed");
    const second = parseSpent(getRun(later, blocked.id)!.spent).attentionAtByKind?.orchestrator_failed;
    expect(second).toBe(NOW + 100);
    expect(second).not.toBe(first);

    const item = deriveWorkflowAttention(later).find(i => i.id === `orchestrator_failed:${run.id}`);
    expect(item?.since).toBe(NOW + 100);
  });

  test("set_planner clears unresolved_wake and orchestrator_failed stamps when unblocking", async () => {
    const ctx = fakeCtx({ now: NOW });
    let run = insertRun(ctx, { workflow: "t/n52-sp", version: 1, repo: tmpDir(), brief: "b" });
    run = updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "unresolved wake step_failed:x after 2 done turns",
      spent: serializeSpent({
        orchestratorTurns: 1, messageTurns: 0,
        blockedBy: "unresolved",
        unresolvedWakes: { "step_failed:x": 2 },
      }),
    });
    stampAttentionAt(ctx, run.id, "unresolved_wake");
    stampAttentionAt(ctx, run.id, "orchestrator_failed");
    await callOp(ctx, "run.set_planner", {
      id: run.id, planner: "codex", expect_rev: getRun(ctx, run.id)!.rev,
    });
    const spent = parseSpent(getRun(ctx, run.id)!.spent);
    expect(spent.attentionAtByKind?.unresolved_wake).toBeUndefined();
    expect(spent.attentionAtByKind?.orchestrator_failed).toBeUndefined();
  });

  test("clearAttentionAt without kind leaves per-kind stamps (real assertion)", () => {
    const ctx = fakeCtx({ now: NOW });
    const run = insertRun(ctx, { workflow: "t/n52-clear", version: 1, repo: tmpDir(), brief: "b" });
    stampAttentionAt(ctx, run.id, "budget_spent");
    stampAttentionAt({ ...ctx, now: NOW + 10 }, run.id, "orchestrator_failed");
    clearAttentionAt(ctx, run.id);
    const after = parseSpent(getRun(ctx, run.id)!.spent);
    expect(after.attentionAtByKind?.budget_spent).toBe(NOW);
    expect(after.attentionAtByKind?.orchestrator_failed).toBe(NOW + 10);
  });
});
