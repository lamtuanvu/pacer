import { realpathSafe } from "../core/git";
import { pidAlive } from "../link/pid";
import { listTasksWhere } from "../tasks/store";
import type { Ctx } from "../types";

/**
 * Another task owns this checkout in place: its path is the canonical Git top, inside it, or a folder that contains
 * it. Called at route admission and again when the run directory is claimed.
 */
export function checkoutOccupied(ctx: Ctx, taskId: string, top: string): boolean {
  const root = realpathSafe(top);
  const overlaps = (path: string) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`);
  return listTasksWhere(ctx, { states: ["queued", "running"] }).some(other => other.id !== taskId &&
    overlaps(realpathSafe(other.worktree ?? other.result?.worktree ?? other.brief.repo)) &&
    (other.interactionMode === "conversation" && other.placement?.requested === "current" ||
      other.state === "running" && other.placement?.mode === "current" && !!other.runnerPid && pidAlive(other.runnerPid)));
}
