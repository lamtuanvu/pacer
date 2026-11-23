// Pacing pauses and wake-up windows for runs (Phase 6 Task 2 / D4).
// Spec table under "Cost control": relaxed/normal unchanged; strict pauses
// background and widens normal wake coalesce to 10 minutes; emergency pauses
// normal+background and only person-caused / urgent wake-ups start turns.
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { readHold } from "../core/mode-hold";
import { type Mode, statusMode } from "../engine/mode";
import { computeStatus } from "../engine/status";
import { loadStrategy } from "../config/strategy";
import { COALESCE_WINDOW_S } from "./budget";
import { runPriorityOf, type RunPriority } from "./priority";
import {
  getRun, hasLiveRuns, liveRuns, updateRun, workflowDatabase, type RunRow,
} from "./store";

/** Live descendant run ids (BFS), excluding `rootId` itself. */
function liveDescendantIds(ctx: Ctx, rootId: string): string[] {
  const out: string[] = [];
  const queue = [rootId];
  const seen = new Set<string>([rootId]);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const children = workflowDatabase(ctx).query<{ id: string }, [string]>(
      "SELECT id FROM workflow_runs WHERE parent_run_id = ? AND status IN ('running', 'waiting')",
    ).all(id);
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id);
      queue.push(child.id);
    }
  }
  return out;
}

export const STRICT_WAKE_WINDOW_S = 10 * 60;

export const PAUSED_REASONS = [
  "pacing: strict",
  "pacing: emergency",
  "budget",
  "person",
] as const;
export type PausedReason = (typeof PAUSED_REASONS)[number];

export type PacingMode = Mode;

/** Pacing pause reason required by the current mode for this priority, or null. */
export function pacingPauseReason(mode: PacingMode, priority: RunPriority): Extract<PausedReason, `pacing: ${string}`> | null {
  if (mode === "strict" && priority === "background") return "pacing: strict";
  if (mode === "emergency" && (priority === "normal" || priority === "background")) {
    return "pacing: emergency";
  }
  return null;
}

export function isPersonPaused(run: Pick<RunRow, "pausedReason">): boolean {
  return run.pausedReason === "person";
}

export function isPacingPaused(run: Pick<RunRow, "pausedReason">): boolean {
  return run.pausedReason === "pacing: strict" || run.pausedReason === "pacing: emergency";
}

/** True when the run must not start a new step (person or pacing pause). */
export function isRunStepPaused(run: Pick<RunRow, "pausedReason">): boolean {
  return !!run.pausedReason && run.pausedReason !== "budget";
}

/**
 * Whether open wake-ups may start an orchestrator turn under the mode × priority
 * rules. Person-caused wake-ups always may; paused non-person wakes do not.
 */
export function wakeAllowsStart(
  now: number,
  mode: PacingMode,
  priority: RunPriority,
  wakeups: { createdAt: number; byPerson?: boolean }[],
  pausedReason?: PausedReason | null,
): boolean {
  if (wakeups.length === 0) return false;
  const person = wakeups.some(w => w.byPerson);
  if (person) return true;

  // A person/pacing pause blocks non-person turns; urgent under emergency is never paused.
  if (pausedReason === "person" || pausedReason === "pacing: strict" || pausedReason === "pacing: emergency") {
    return false;
  }

  if (mode === "emergency") {
    // Only urgent runs' non-person wakes start turns (normal/background are paused).
    if (priority !== "urgent") return false;
    const oldest = Math.min(...wakeups.map(w => w.createdAt));
    return now - oldest >= COALESCE_WINDOW_S;
  }

  if (mode === "strict" && priority === "normal") {
    const oldest = Math.min(...wakeups.map(w => w.createdAt));
    return now - oldest >= STRICT_WAKE_WINDOW_S;
  }

  const oldest = Math.min(...wakeups.map(w => w.createdAt));
  return now - oldest >= COALESCE_WINDOW_S;
}

/** Read the effective pacing mode (hold wins; else planner-derived). Stubable in tests. */
export type ModeReader = (ctx: Ctx) => PacingMode | Promise<PacingMode>;

export async function readPacingMode(ctx: Ctx, opts: { cacheOnly?: boolean } = {}): Promise<PacingMode> {
  const hold = readHold(ctx);
  if (hold) return hold.mode;
  try {
    const strategy = loadStrategy(ctx);
    const status = await computeStatus(ctx, strategy, { cacheOnly: opts.cacheOnly ?? true });
    return status.mode;
  } catch {
    return statusMode(null, undefined);
  }
}

/**
 * Sync a run's pacing pause with the current mode. Person pauses are left alone.
 * Returns the updated run when a write happened, else the input.
 */
export function syncRunPacingPause(
  ctx: Ctx,
  run: RunRow,
  mode: PacingMode,
): RunRow {
  if (isPersonPaused(run)) return run;
  const needed = pacingPauseReason(mode, runPriorityOf(run));
  if (needed) {
    if (run.pausedReason === needed) return run;
    return updateRun(ctx, run.id, run.rev, { pausedReason: needed });
  }
  if (isPacingPaused(run)) {
    return updateRun(ctx, run.id, run.rev, { pausedReason: null });
  }
  return run;
}

/** Apply a person pause/resume patch to one child with a few rev retries. */
function patchChildPersonPause(
  ctx: Ctx,
  childId: string,
  patch: { pausedReason: "person" } | { pausedReason: null },
  mode?: PacingMode,
): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const child = getRun(ctx, childId);
    if (!child) return;
    if (patch.pausedReason === "person" && isPersonPaused(child)) return;
    if (patch.pausedReason === null && !isPersonPaused(child)) return;
    try {
      const next = updateRun(ctx, childId, child.rev, patch);
      if (patch.pausedReason === null && mode) syncRunPacingPause(ctx, next, mode);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new CoreError("conflict", `conflict: could not update child run ${childId}: ${msg}`);
}

/**
 * Person pause on the run and every live descendant (same reach as pacing pauses
 * across the tree). expectRev applies only to the targeted run. Child rev conflicts
 * are retried then reported (never swallowed).
 */
export function pauseRunByPerson(ctx: Ctx, id: string, expectRev: number): RunRow {
  const root = updateRun(ctx, id, expectRev, { pausedReason: "person" });
  const failures: string[] = [];
  for (const childId of liveDescendantIds(ctx, id)) {
    try {
      patchChildPersonPause(ctx, childId, { pausedReason: "person" });
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failures.length > 0) {
    throw new CoreError("conflict", `pause incomplete for ${failures.length} child run(s): ${failures.join("; ")}`);
  }
  return root;
}

/**
 * Person resume on the run and every live descendant. After clearing, re-apply
 * pacing if the mode still requires it so the tree does not ignore strict/emergency.
 * Child rev conflicts are retried then reported (never swallowed).
 */
export function resumeRunByPerson(
  ctx: Ctx,
  id: string,
  expectRev: number,
  mode: PacingMode,
): RunRow {
  const cleared = updateRun(ctx, id, expectRev, { pausedReason: null });
  const root = syncRunPacingPause(ctx, cleared, mode);
  const failures: string[] = [];
  for (const childId of liveDescendantIds(ctx, id)) {
    try {
      patchChildPersonPause(ctx, childId, { pausedReason: null }, mode);
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failures.length > 0) {
    throw new CoreError("conflict", `resume incomplete for ${failures.length} child run(s): ${failures.join("; ")}`);
  }
  return root;
}

/** Apply mode-driven pauses/resumes across every live run. */
export async function applyPacingToLiveRuns(
  ctx: Ctx,
  readMode: ModeReader = (c) => readPacingMode(c, { cacheOnly: true }),
): Promise<number> {
  // Cheap live-run check first: installs without workflows pay nothing for mode.
  if (!hasLiveRuns(ctx)) return 0;
  const mode = await readMode(ctx);
  let changed = 0;
  for (const run of liveRuns(ctx)) {
    const before = run.pausedReason ?? null;
    const after = syncRunPacingPause(ctx, run, mode);
    if ((after.pausedReason ?? null) !== before) changed++;
  }
  return changed;
}

export function getLiveRun(ctx: Ctx, id: string): RunRow | null {
  return getRun(ctx, id);
}
