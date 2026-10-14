import { join, resolve } from "node:path";
import { loadStrategy } from "../config/strategy";
import { isTaskId } from "../tasks/store";
import type { Ctx } from "../types";
import { isObj } from "../util";

/** Orca new-child worktrees are named pacer-<taskId>-<providerId>; pacer's own task worktrees live under <pacerHome>/worktrees/<repo>/<taskId>. */
export function isExecutorSession(ctx: Ctx, input?: unknown): boolean {
  if (ctx.env.PACER_ROLE === "executor") return true;
  const paths = [process.cwd(), ...(isObj(input) && typeof input.cwd === "string" ? [input.cwd] : [])];
  const own = join(ctx.pacerHome, "worktrees") + "/";
  if (paths.some(path => { const p = resolve(path); if (!p.startsWith(own)) return false; const id = p.slice(own.length).split("/")[1]; return !!id && isTaskId(id); })) return true;
  return paths.some(path => {
    const match = /\/orca\/workspaces\/[^/]+\/pacer-(t-\d{8}-\d{6}-[0-9a-f]{4})-([^/]+)(?:\/|$)/.exec(resolve(path));
    if (!match || !isTaskId(match[1])) return false;
    try { return Object.hasOwn(loadStrategy(ctx).providers, match[2]); }
    catch { return false; }
  });
}

export function plannerPolicyApplies(ctx: Ctx, planner: string, input?: unknown): boolean {
  if (isExecutorSession(ctx, input)) return false;
  try { return loadStrategy(ctx).planner === planner; }
  catch { return true; } // Preserve existing missing-strategy/fail-open behavior.
}

export function hookInput(stdin: string): unknown {
  try { return JSON.parse(stdin); } catch { return undefined; }
}
