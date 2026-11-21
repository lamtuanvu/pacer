// Workflow-run attention derived from live run state (D2.4 / round-2 I3): budget
// exhaustion and orchestrator failures, with actions that include expect_rev and
// concrete run.set_budget / run.set_planner params. since/raisedAt are stable via
// spent.attention_at (no orchestrator-attention.json / budget-attention.json).
import type { Ctx } from "../types";
import type { AttentionItem } from "../attention/types";
import { PLANNERS } from "../config/strategy";
import { liveRuns, type RunRow } from "./store";
import { DEFAULT_BUDGET, isBudgetBlocked, parseBudget, parseSpent } from "./budget";

function attentionClock(ctx: Ctx, run: RunRow, kind = "default"): number {
  const spent = parseSpent(run.spent);
  const byKind = spent.attentionAtByKind?.[kind];
  if (typeof byKind === "number" && byKind > 0) return byKind;
  // Legacy scalar only when no per-kind map exists — never revive a cleared kind
  // via attentionAt while another kind's stamp remains (A-M5).
  if (!spent.attentionAtByKind
    && typeof spent.attentionAt === "number" && spent.attentionAt > 0) {
    return spent.attentionAt;
  }
  // Fall back to the run's last update when blocked/spent was first recorded.
  return run.updatedAt || ctx.now;
}

function raiseBudgetParams(run: RunRow, which: "orchestrator" | "message"): Record<string, unknown> {
  const budget = parseBudget(run.budget);
  if (which === "message") {
    return {
      id: run.id,
      expect_rev: run.rev,
      message_turns: Math.max(budget.messageTurns + 20, DEFAULT_BUDGET.messageTurns),
    };
  }
  return {
    id: run.id,
    expect_rev: run.rev,
    orchestrator_turns: Math.max(budget.orchestratorTurns + 20, DEFAULT_BUDGET.orchestratorTurns),
  };
}

/** A planner different from the current one so Switch planner is not a no-op. */
function switchPlannerTarget(current: string | undefined): string {
  const cur = current ?? "claude-code";
  return (PLANNERS as readonly string[]).find(p => p !== cur) ?? "codex";
}

/** Attention items for live runs: blocked orchestrator and budget thresholds. */
export function deriveWorkflowAttention(ctx: Ctx): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const run of liveRuns(ctx)) {
    // Child runs share the root's orchestrator/budget attention.
    if (run.parentRunId) continue;
    const budget = parseBudget(run.budget);
    const spent = parseSpent(run.spent);
    if (run.orchestratorState === "blocked") {
      const budgetSpent = isBudgetBlocked(run);
      const unresolved = parseSpent(run.spent).blockedBy === "unresolved"
        || (!budgetSpent && !!run.reason?.includes("unresolved"));
      const kindKey = budgetSpent ? "budget_spent" : unresolved ? "unresolved_wake" : "orchestrator_failed";
      const at = attentionClock(ctx, run, kindKey);
      items.push({
        id: `${kindKey}:${run.id}`,
        kind: budgetSpent ? "question" : "orchestrator_failed",
        severity: budgetSpent ? "decide" : "blocked",
        repo: null,
        title: budgetSpent
          ? `Turn budget spent for ${run.id}`
          : unresolved
          ? `Unresolved wake for ${run.title}`
          : `Orchestrator failed for ${run.title}`,
        detail: budgetSpent
          ? "Raise the budget or stop the run"
          : (run.reason ?? `planner failed`),
        raisedAt: at,
        since: at,
        notify: "important",
        actions: budgetSpent
          ? [
            { label: "Raise budget", op: "run.set_budget", params: raiseBudgetParams(run, "orchestrator"), style: "primary" },
            { label: "Stop run", op: "run.stop", params: { id: run.id, expect_rev: run.rev }, style: "danger", confirm: "Stop this run?" },
          ]
          : [
            { label: "Retry now", op: "run.retry_orchestrator", params: { id: run.id, expect_rev: run.rev } },
            { label: "Switch planner", op: "run.set_planner", params: { id: run.id, expect_rev: run.rev, planner: switchPlannerTarget(run.planner) } },
            { label: "Stop the run", op: "run.stop", params: { id: run.id, expect_rev: run.rev }, style: "danger" },
          ],
      });
      continue;
    }
    if (spent.orchestratorTurns >= budget.orchestratorTurns && budget.orchestratorTurns > 0) {
      const at = attentionClock(ctx, run, "budget_spent");
      items.push({
        id: `budget_spent:${run.id}`,
        kind: "question",
        severity: "decide",
        repo: null,
        title: `Turn budget spent for ${run.id}`,
        detail: "Raise the budget or stop the run",
        raisedAt: at,
        since: at,
        notify: "important",
        actions: [
          { label: "Raise budget", op: "run.set_budget", params: raiseBudgetParams(run, "orchestrator"), style: "primary" },
          { label: "Stop run", op: "run.stop", params: { id: run.id, expect_rev: run.rev }, style: "danger", confirm: "Stop this run?" },
        ],
      });
    } else if (budget.orchestratorTurns > 0 && spent.orchestratorTurns / budget.orchestratorTurns >= 0.8) {
      const at = attentionClock(ctx, run, "budget_warn");
      items.push({
        id: `budget_warn:${run.id}`,
        kind: "limit",
        severity: "problem",
        repo: null,
        title: `Run ${run.id} at 80% orchestrator turn budget`,
        detail: `Used ${spent.orchestratorTurns} of ${budget.orchestratorTurns} orchestrator turns.`,
        raisedAt: at,
        since: at,
        notify: "all",
        actions: [
          { label: "Raise budget", op: "run.set_budget", params: raiseBudgetParams(run, "orchestrator"), style: "primary" },
        ],
      });
    }
    if (spent.messageTurns >= budget.messageTurns && budget.messageTurns > 0) {
      const at = attentionClock(ctx, run, "budget_msg_spent");
      items.push({
        id: `budget_msg_spent:${run.id}`,
        kind: "question",
        severity: "decide",
        repo: null,
        title: `Message turn budget spent for ${run.id}`,
        detail: "Raise the budget or stop the run",
        raisedAt: at,
        since: at,
        notify: "important",
        actions: [
          { label: "Raise budget", op: "run.set_budget", params: raiseBudgetParams(run, "message"), style: "primary" },
          { label: "Stop run", op: "run.stop", params: { id: run.id, expect_rev: run.rev }, style: "danger", confirm: "Stop this run?" },
        ],
      });
    } else if (budget.messageTurns > 0 && spent.messageTurns / budget.messageTurns >= 0.8) {
      const at = attentionClock(ctx, run, "budget_msg_warn");
      items.push({
        id: `budget_msg_warn:${run.id}`,
        kind: "limit",
        severity: "problem",
        repo: null,
        title: `Run ${run.id} at 80% message turn budget`,
        detail: `Used ${spent.messageTurns} of ${budget.messageTurns} message turns.`,
        raisedAt: at,
        since: at,
        notify: "all",
        actions: [
          { label: "Raise budget", op: "run.set_budget", params: raiseBudgetParams(run, "message"), style: "primary" },
        ],
      });
    }
  }
  return items;
}

/** Budget / message attention for a run from the live derive path. */
export function getBudgetAttention(ctx: Ctx, runId: string): AttentionItem | null {
  return deriveWorkflowAttention(ctx).find(i =>
    i.id === `budget_spent:${runId}`
    || i.id === `budget_warn:${runId}`
    || i.id === `budget_msg_spent:${runId}`
    || i.id === `budget_msg_warn:${runId}`,
  ) ?? null;
}

/** Orchestrator-failed / unresolved-wake attention for a run from the live derive path. */
export function getOrchestratorAttention(ctx: Ctx, runId: string): AttentionItem | null {
  return deriveWorkflowAttention(ctx).find(i =>
    i.id === `orchestrator_failed:${runId}` || i.id === `unresolved_wake:${runId}`,
  ) ?? null;
}
