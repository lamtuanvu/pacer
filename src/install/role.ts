import { resolve } from "node:path";
import { loadStrategy } from "../config/strategy";
import { isTaskId } from "../tasks/store";
import type { Ctx } from "../types";
import { isObj } from "../util";

/** Orca new-child worktrees are named pacer-<taskId>-<providerId>. */
export function isExecutorSession(ctx: Ctx, input?: unknown): boolean {
  if (ctx.env.PACER_ROLE === "executor") return true;
  const paths = [process.cwd(), ...(isObj(input) && typeof input.cwd === "string" ? [input.cwd] : [])];
  return paths.some(path => {
    const match = /\/orca\/workspaces\/[^/]+\/pacer-(t-\d{8}-\d{6}-[0-9a-f]{4})-([^/]+)(?:\/|$)/.exec(resolve(path));
    if (!match || !isTaskId(match[1])) return false;
    try { return Object.hasOwn(loadStrategy(ctx).providers, match[2]); }
    catch { return false; }
  });
}

export function plannerPolicyApplies(ctx: Ctx, planner: string, input?: unknown): boolean {
  if (isExecutorSession(ctx, input)) return false;
  try { return loadStrategy(ctx).planner.agent === planner; }
  catch { return true; } // Preserve existing missing-strategy/fail-open behavior.
}

export function hookInput(stdin: string): unknown {
  try { return JSON.parse(stdin); } catch { return undefined; }
}
