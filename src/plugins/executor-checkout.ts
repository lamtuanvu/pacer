import { realpathSafe } from "../core/git";
import { pidAlive } from "../link/pid";
import { listTasksWhere, readTask } from "../tasks/store";
import type { Ctx } from "../types";
import { stepByTask } from "../workflow/store";

/**
 * Another task owns this checkout in place: its path is the canonical Git top, inside it, or a folder that contains
 * it. Called at route admission and again when the run directory is claimed.
 *
 * Concurrent research may share a `current` checkout only when both tasks are
 * workflow step tasks of the same run. Ordinary research delegates and conversation
 * lanes stay exclusive: "research is read-only" is a label, not a sandbox.
 * A writer (any non-research task) still owns exclusively against everyone.
 */
function sameRunResearchSteps(ctx: Ctx, selfId: string, otherId: string): boolean {
  const self = readTask(ctx, selfId), other = readTask(ctx, otherId);
  if (self?.kind !== "research" || other?.kind !== "research") return false;
  const selfStep = stepByTask(ctx, selfId), otherStep = stepByTask(ctx, otherId);
  return !!selfStep && !!otherStep && selfStep.runId === otherStep.runId;
}

export function checkoutOccupied(ctx: Ctx, taskId: string, top: string): boolean {
  const root = realpathSafe(top);
  const overlaps = (path: string) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`);
  return listTasksWhere(ctx, { states: ["queued", "running"] }).some(other => other.id !== taskId &&
    !sameRunResearchSteps(ctx, taskId, other.id) &&
    overlaps(realpathSafe(other.worktree ?? other.result?.worktree ?? other.brief.repo)) &&
    (other.interactionMode === "conversation" && other.placement?.requested === "current" ||
      other.state === "running" && other.placement?.mode === "current" && !!other.runnerPid && pidAlive(other.runnerPid)));
}
