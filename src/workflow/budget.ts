// Per-run orchestrator and message-turn budgets (D3). Defaults 60 / 20; at 80% an
// informational attention item; at 100% of orchestrator turns, startTurn returns
// null with orchestrator state blocked and a must question to raise or stop.
// Attention is derived live (no budget-attention.json side file).
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { getRun, rootRunId, updateRun, type RunRow } from "./store";
import type { WorkflowDef } from "./schema";

export const DEFAULT_BUDGET = { orchestratorTurns: 60, messageTurns: 20 } as const;
export const COALESCE_WINDOW_S = 30;

export type Budget = { orchestratorTurns: number; messageTurns: number };
/** attentionAt is the first time a budget/orchestrator attention item was raised (stable since). */
export type Spent = {
  orchestratorTurns: number;
  messageTurns: number;
  attentionAt?: number;
  /** Per-kind stable since clocks (round-3): kind → unix seconds. */
  attentionAtByKind?: Record<string, number>;
  /** Structured block marker — prefer this over parsing reason text (round-3). */
  blockedBy?: "budget" | "unresolved";
  /** Consecutive done turns that left the same wake cause open (I5). */
  unresolvedWakes?: Record<string, number>;
};

/** True when the run is blocked because the orchestrator turn budget is spent.
 *  Requires both a blocked state and spent >= budget so a stale blockedBy marker
 *  cannot misclassify a later planner-failure block (G2). */
export function isBudgetBlocked(run: {
  orchestratorState?: string | null;
  reason?: string | null;
  spent?: string | null;
  budget?: string | null;
}): boolean {
  if (run.orchestratorState !== "blocked") return false;
  const spent = parseSpent(run.spent);
  const budget = parseBudget(run.budget);
  if (spent.orchestratorTurns < budget.orchestratorTurns) return false;
  if (spent.blockedBy === "budget") return true;
  // Legacy rows written before blockedBy existed.
  return run.reason === "turn budget spent";
}

export function parseBudget(raw: string | undefined | null): Budget {
  if (!raw) return { ...DEFAULT_BUDGET };
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      orchestratorTurns: typeof v.orchestrator_turns === "number" ? v.orchestrator_turns
        : typeof v.orchestratorTurns === "number" ? v.orchestratorTurns
        : DEFAULT_BUDGET.orchestratorTurns,
      messageTurns: typeof v.message_turns === "number" ? v.message_turns
        : typeof v.messageTurns === "number" ? v.messageTurns
        : DEFAULT_BUDGET.messageTurns,
    };
  } catch {
    return { ...DEFAULT_BUDGET };
  }
}

export function parseSpent(raw: string | undefined | null): Spent {
  if (!raw) return { orchestratorTurns: 0, messageTurns: 0 };
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const attentionRaw = v.attention_at ?? v.attentionAt;
    const byKindRaw = v.attention_at_by_kind ?? v.attentionAtByKind;
    const blockedRaw = v.blocked_by ?? v.blockedBy;
    const unresolvedRaw = v.unresolved_wakes ?? v.unresolvedWakes;
    const unresolvedWakes = unresolvedRaw && typeof unresolvedRaw === "object" && !Array.isArray(unresolvedRaw)
      ? Object.fromEntries(
        Object.entries(unresolvedRaw as Record<string, unknown>)
          .filter(([, n]) => typeof n === "number" && n > 0)
          .map(([k, n]) => [k, n as number]),
      )
      : undefined;
    const attentionAtByKind = byKindRaw && typeof byKindRaw === "object" && !Array.isArray(byKindRaw)
      ? Object.fromEntries(
        Object.entries(byKindRaw as Record<string, unknown>)
          .filter(([, n]) => typeof n === "number" && n > 0)
          .map(([k, n]) => [k, n as number]),
      )
      : undefined;
    return {
      orchestratorTurns: typeof v.orchestrator_turns === "number" ? v.orchestrator_turns
        : typeof v.orchestratorTurns === "number" ? v.orchestratorTurns
        : 0,
      messageTurns: typeof v.message_turns === "number" ? v.message_turns
        : typeof v.messageTurns === "number" ? v.messageTurns
        : 0,
      ...(typeof attentionRaw === "number" && attentionRaw > 0 ? { attentionAt: attentionRaw } : {}),
      ...(attentionAtByKind && Object.keys(attentionAtByKind).length > 0 ? { attentionAtByKind } : {}),
      ...(blockedRaw === "budget" || blockedRaw === "unresolved" ? { blockedBy: blockedRaw } : {}),
      ...(unresolvedWakes && Object.keys(unresolvedWakes).length > 0 ? { unresolvedWakes } : {}),
    };
  } catch {
    return { orchestratorTurns: 0, messageTurns: 0 };
  }
}

export function serializeBudget(b: Budget): string {
  return JSON.stringify({ orchestrator_turns: b.orchestratorTurns, message_turns: b.messageTurns });
}

export function serializeSpent(s: Spent): string {
  return JSON.stringify({
    orchestrator_turns: s.orchestratorTurns,
    message_turns: s.messageTurns,
    ...(s.attentionAt !== undefined ? { attention_at: s.attentionAt } : {}),
    ...(s.attentionAtByKind && Object.keys(s.attentionAtByKind).length > 0
      ? { attention_at_by_kind: s.attentionAtByKind }
      : {}),
    ...(s.blockedBy ? { blocked_by: s.blockedBy } : {}),
    ...(s.unresolvedWakes && Object.keys(s.unresolvedWakes).length > 0
      ? { unresolved_wakes: s.unresolvedWakes }
      : {}),
  });
}

/** Stamp attention_at on first raise so since/raisedAt stay stable across ticks. */
export function stampAttentionAt(ctx: Ctx, runId: string, kind = "default"): void {
  for (let attempt = 0; attempt < 8; attempt++) {
    const run = getRun(ctx, runId);
    if (!run) return;
    const spent = parseSpent(run.spent);
    spent.attentionAtByKind ??= {};
    if (spent.attentionAtByKind[kind] !== undefined && spent.attentionAt !== undefined) return;
    if (spent.attentionAt === undefined) spent.attentionAt = ctx.now;
    if (spent.attentionAtByKind[kind] === undefined) spent.attentionAtByKind[kind] = ctx.now;
    const patched = patchSpent(ctx, runId, spent);
    if (patched) return;
  }
}

/** Clear the stable attention clock once the condition is gone.
 *  Without a kind, only clears the legacy `attentionAt` scalar — never all
 *  per-kind stamps (A-m2). Pass an explicit kind to clear that kind. */
export function clearAttentionAt(ctx: Ctx, runId: string, kind?: string): void {
  for (let attempt = 0; attempt < 8; attempt++) {
    const run = getRun(ctx, runId);
    if (!run) return;
    const spent = parseSpent(run.spent);
    if (kind) {
      if (!spent.attentionAtByKind?.[kind] && spent.attentionAt === undefined) return;
      if (spent.attentionAtByKind) delete spent.attentionAtByKind[kind];
      if (spent.attentionAtByKind && Object.keys(spent.attentionAtByKind).length === 0) {
        delete spent.attentionAtByKind;
        delete spent.attentionAt;
      }
    } else {
      if (spent.attentionAt === undefined) return;
      delete spent.attentionAt;
    }
    const patched = patchSpent(ctx, runId, spent);
    if (patched) return;
  }
}

/** Budget for a new run from the definition's policy, with optional overrides. */
export function budgetForDefinition(def: WorkflowDef, override?: Partial<Budget>): Budget {
  const fromPolicy = def.policy?.budget;
  return {
    orchestratorTurns: override?.orchestratorTurns
      ?? fromPolicy?.orchestrator_turns
      ?? DEFAULT_BUDGET.orchestratorTurns,
    messageTurns: override?.messageTurns
      ?? fromPolicy?.message_turns
      ?? DEFAULT_BUDGET.messageTurns,
  };
}

/** Stamp the kind attention reads (budget_warn / budget_spent / budget_msg_*). */
function raiseBudgetAttention(ctx: Ctx, runId: string, kind: string): void {
  stampAttentionAt(ctx, runId, kind);
}

/** Clear only the kinds a raise/refund resolves (A-M4). */
function clearBudgetAttention(ctx: Ctx, runId: string, kinds: string[]): void {
  for (const kind of kinds) {
    clearAttentionAt(ctx, runId, kind);
  }
}

/** Persist spent with rev retry so a concurrent patch cannot drop a count (D2.11). */
function patchSpent(ctx: Ctx, runId: string, spent: Spent): RunRow | null {
  for (let attempt = 0; attempt < 8; attempt++) {
    const run = getRun(ctx, runId);
    if (!run) return null;
    try {
      return updateRun(ctx, runId, run.rev, { spent: serializeSpent(spent) });
    } catch {
      // Rev conflict: re-read and retry with the new spent absolute value.
    }
  }
  return getRun(ctx, runId);
}

function afterSpend(ctx: Ctx, runId: string): void {
  const run = getRun(ctx, runId);
  if (!run) return;
  const budget = parseBudget(run.budget);
  const spent = parseSpent(run.spent);
  const ratio = budget.orchestratorTurns > 0 ? spent.orchestratorTurns / budget.orchestratorTurns : 0;
  if (spent.orchestratorTurns >= budget.orchestratorTurns) {
    spent.blockedBy = "budget";
    try {
      updateRun(ctx, runId, run.rev, {
        orchestratorState: "blocked",
        reason: "turn budget spent",
        spent: serializeSpent(spent),
      });
    } catch { /* concurrent */ }
    raiseBudgetAttention(ctx, runId, "budget_spent");
  } else if (ratio >= 0.8) {
    raiseBudgetAttention(ctx, runId, "budget_warn");
  }
}

/** Count one orchestrator turn against the root run. */
export function countOrchestratorTurn(ctx: Ctx, runId: string): void {
  const root = rootRunId(ctx, runId);
  const run = getRun(ctx, root);
  if (!run) return;
  const spent = parseSpent(run.spent);
  spent.orchestratorTurns += 1;
  patchSpent(ctx, root, spent);
  afterSpend(ctx, root);
}

/** Undo a counted orchestrator turn (planner-at-limit: the turn must not spend budget). */
export function refundOrchestratorTurn(ctx: Ctx, runId: string): void {
  const root = rootRunId(ctx, runId);
  const run = getRun(ctx, root);
  if (!run) return;
  const spent = parseSpent(run.spent);
  if (spent.orchestratorTurns <= 0) return;
  spent.orchestratorTurns -= 1;
  patchSpent(ctx, root, spent);
  // Re-read after patchSpent so the clear write does not use a stale rev (S-NEW-5).
  const fresh = getRun(ctx, root);
  if (!fresh) return;
  const budget = parseBudget(fresh.budget);
  const next = parseSpent(fresh.spent);
  if (next.orchestratorTurns < budget.orchestratorTurns
    && (isBudgetBlocked(fresh) || next.blockedBy === "budget")) {
    delete next.blockedBy;
    try {
      updateRun(ctx, root, fresh.rev, {
        orchestratorState: "idle", reason: null, spent: serializeSpent(next),
      });
    } catch { /* concurrent */ }
    clearBudgetAttention(ctx, root, ["budget_spent", "budget_warn"]);
  }
}

/** Count one cross-run message turn against the sender's root run. */
export function countMessageTurn(ctx: Ctx, runId: string): void {
  const root = rootRunId(ctx, runId);
  const run = getRun(ctx, root);
  if (!run) return;
  const spent = parseSpent(run.spent);
  spent.messageTurns += 1;
  patchSpent(ctx, root, spent);
  const fresh = getRun(ctx, root) ?? run;
  const budget = parseBudget(fresh.budget);
  const next = parseSpent(fresh.spent);
  if (next.messageTurns >= budget.messageTurns) {
    raiseBudgetAttention(ctx, root, "budget_msg_spent");
  } else if (budget.messageTurns > 0 && next.messageTurns / budget.messageTurns >= 0.8) {
    raiseBudgetAttention(ctx, root, "budget_msg_warn");
  }
}

/** Whether a cross-run message turn may start against this run's message budget. */
export function budgetAllowsMessage(ctx: Ctx, runId: string): boolean {
  const root = getRun(ctx, rootRunId(ctx, runId));
  if (!root) return true;
  const budget = parseBudget(root.budget);
  const spent = parseSpent(root.spent);
  return spent.messageTurns < budget.messageTurns;
}

/** Whether startTurn may begin another orchestrator turn. */
export function budgetAllowsTurn(ctx: Ctx, run: RunRow): boolean {
  const root = getRun(ctx, rootRunId(ctx, run.id)) ?? run;
  const budget = parseBudget(root.budget);
  const spent = parseSpent(root.spent);
  return spent.orchestratorTurns < budget.orchestratorTurns;
}

/** After raising the budget, clear the blocked state when room remains.
 *  Always drop blockedBy when room remains — a stale marker must not outlive the raise (G2). */
export function applyBudgetRaise(ctx: Ctx, runId: string, expectRev: number, patch: Partial<Budget>): RunRow {
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  const current = parseBudget(run.budget);
  const next: Budget = {
    orchestratorTurns: patch.orchestratorTurns ?? current.orchestratorTurns,
    messageTurns: patch.messageTurns ?? current.messageTurns,
  };
  const spent = parseSpent(run.spent);
  const cleared = spent.orchestratorTurns < next.orchestratorTurns;
  const wasBudgetBlock = isBudgetBlocked(run)
    || spent.blockedBy === "budget"
    || run.reason === "turn budget spent";
  // Only clear a budget marker — never drop a legitimate unresolved block (N5-6).
  if (cleared && spent.blockedBy === "budget") delete spent.blockedBy;
  const updated = updateRun(ctx, runId, expectRev, {
    budget: serializeBudget(next),
    ...(cleared
      ? {
        spent: serializeSpent(spent),
        ...(wasBudgetBlock && run.orchestratorState === "blocked"
          ? { orchestratorState: "idle" as const, reason: null }
          : {}),
      }
      : {}),
  });
  if (cleared) clearBudgetAttention(ctx, runId, ["budget_spent", "budget_warn"]);
  else if (spent.orchestratorTurns >= next.orchestratorTurns) {
    raiseBudgetAttention(ctx, runId, "budget_spent");
  }
  // stamp/clear may bump rev via spent patch — return the freshest row.
  return getRun(ctx, runId) ?? updated;
}

/**
 * Coalesce window: do not start a turn until the oldest open wake-up is at least
 * COALESCE_WINDOW_S old, unless any open wake-up was caused by the person.
 */
export function coalesceAllowsStart(
  now: number,
  wakeups: { createdAt: number; byPerson?: boolean }[],
): boolean {
  if (wakeups.length === 0) return false;
  if (wakeups.some(w => w.byPerson)) return true;
  const oldest = Math.min(...wakeups.map(w => w.createdAt));
  return now - oldest >= COALESCE_WINDOW_S;
}
