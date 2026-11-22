// Workflow-run attention derived from live run state (D2.4 / round-2 I3): budget
// exhaustion and orchestrator failures, with actions that include expect_rev and
// concrete run.set_budget / run.set_planner params. since/raisedAt are stable via
// spent.attention_at (no orchestrator-attention.json / budget-attention.json).
import type { Ctx } from "../types";
import type { Action, AttentionItem } from "../attention/types";
import { PLANNERS } from "../config/strategy";
import { agentInfo } from "../view-model/agents";
import { liveRuns, type RunRow } from "./store";
import { isBudgetBlocked, parseBudget, parseSpent } from "./budget";

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

/**
 * Subject for attention titles: `Workflow "<title>"` when titled, otherwise
 * `A workflow run`. Never quotes the untitled fallback. Clips to the first
 * line, at most 60 code points, with an ellipsis when clipped.
 */
function clipTitleLine(line: string, maxCodePoints = 60): string {
  // Count Unicode code points so a surrogate pair (emoji) is never split.
  const points = Array.from(line);
  return points.length > maxCodePoints ? `${points.slice(0, maxCodePoints).join("")}…` : line;
}

function workflowSubject(run: RunRow): string {
  const raw = typeof run.title === "string" ? run.title.trim() : "";
  if (!raw) return "A workflow run";
  const firstLine = raw.split(/\r\n|\r|\n/, 1)[0] ?? raw;
  const clipped = clipTitleLine(firstLine);
  return `Workflow "${clipped}"`;
}

function raiseBudgetParams(run: RunRow, which: "orchestrator" | "message"): Record<string, unknown> {
  const budget = parseBudget(run.budget);
  if (which === "message") {
    return {
      id: run.id,
      expect_rev: run.rev,
      message_turns: budget.messageTurns + 20,
    };
  }
  return {
    id: run.id,
    expect_rev: run.rev,
    orchestrator_turns: budget.orchestratorTurns + 20,
  };
}

/** A planner different from the current one so Switch planner is not a no-op. */
export function switchPlannerTarget(
  current: string | undefined,
  planners: readonly string[] = PLANNERS,
): string | null {
  const cur = current ?? "claude-code";
  return planners.find(p => p !== cur) ?? null;
}

function stopRunAction(run: RunRow): Action {
  return {
    label: "Stop run",
    op: "run.stop",
    params: { id: run.id, expect_rev: run.rev },
    style: "danger",
    confirm: "Stop this run?",
  };
}

function raisePlanningAction(run: RunRow): Action {
  return {
    label: "Add 20 planning steps",
    op: "run.set_budget",
    params: raiseBudgetParams(run, "orchestrator"),
    style: "primary",
  };
}

function raiseMessageAction(run: RunRow): Action {
  return {
    label: "Add 20 messages",
    op: "run.set_budget",
    params: raiseBudgetParams(run, "message"),
    style: "primary",
  };
}

function blockedFailureActions(run: RunRow): Action[] {
  const actions: Action[] = [
    { label: "Retry now", op: "run.retry_orchestrator", params: { id: run.id, expect_rev: run.rev } },
  ];
  const target = switchPlannerTarget(run.planner);
  if (target) {
    actions.push({
      label: `Switch to ${agentInfo(target).name}`,
      op: "run.set_planner",
      params: { id: run.id, expect_rev: run.rev, planner: target },
    });
  }
  actions.push(stopRunAction(run));
  return actions;
}

/** Attention items for live runs: blocked orchestrator and budget thresholds. */
export function deriveWorkflowAttention(ctx: Ctx): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const run of liveRuns(ctx)) {
    // Child runs share the root's orchestrator/budget attention.
    if (run.parentRunId) continue;
    const budget = parseBudget(run.budget);
    const spent = parseSpent(run.spent);
    const subject = workflowSubject(run);
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
          ? `${subject} used its planning budget`
          : unresolved
          ? `${subject} is waiting for a restart`
          : `${subject} stopped`,
        detail: budgetSpent
          ? "Add 20 planning steps."
          : unresolved
          ? "Nothing it did resolved what it was waiting for. Retry now."
          : "The planner failed several times in a row. Retry now.",
        raisedAt: at,
        since: at,
        notify: "important",
        actions: budgetSpent
          ? [raisePlanningAction(run), stopRunAction(run)]
          : blockedFailureActions(run),
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
        title: `${subject} used its planning budget`,
        detail: "Add 20 planning steps.",
        raisedAt: at,
        since: at,
        notify: "important",
        actions: [raisePlanningAction(run), stopRunAction(run)],
      });
    } else if (budget.orchestratorTurns > 0 && spent.orchestratorTurns / budget.orchestratorTurns >= 0.8) {
      const at = attentionClock(ctx, run, "budget_warn");
      items.push({
        id: `budget_warn:${run.id}`,
        // Same kind as the 100% question so view-model attentionStatus is warn, not Out of quota.
        kind: "question",
        severity: "problem",
        repo: null,
        title: `${subject} has used most of its planning budget`,
        detail: `Used ${spent.orchestratorTurns} of ${budget.orchestratorTurns} planning steps.`,
        raisedAt: at,
        since: at,
        notify: "all",
        actions: [raisePlanningAction(run)],
      });
    }
    if (spent.messageTurns >= budget.messageTurns && budget.messageTurns > 0) {
      const at = attentionClock(ctx, run, "budget_msg_spent");
      items.push({
        id: `budget_msg_spent:${run.id}`,
        kind: "question",
        severity: "decide",
        repo: null,
        title: `${subject} used its message budget`,
        detail: "Add 20 messages.",
        raisedAt: at,
        since: at,
        notify: "important",
        actions: [raiseMessageAction(run), stopRunAction(run)],
      });
    } else if (budget.messageTurns > 0 && spent.messageTurns / budget.messageTurns >= 0.8) {
      const at = attentionClock(ctx, run, "budget_msg_warn");
      items.push({
        id: `budget_msg_warn:${run.id}`,
        kind: "question",
        severity: "problem",
        repo: null,
        title: `${subject} has used most of its message budget`,
        detail: `Used ${spent.messageTurns} of ${budget.messageTurns} messages.`,
        raisedAt: at,
        since: at,
        notify: "all",
        actions: [raiseMessageAction(run)],
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
