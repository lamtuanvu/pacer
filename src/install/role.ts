import { resolve } from "node:path";
import { loadStrategy } from "../config/strategy";
import type { Ctx } from "../types";
import { isObj } from "../util";

/** Orca new-child worktrees are named pacer-<taskId>-<providerId>. */
export function isExecutorSession(ctx: Ctx, input?: unknown): boolean {
  if (ctx.env.PACER_ROLE === "executor") return true;
  const paths = [process.cwd(), ...(isObj(input) && typeof input.cwd === "string" ? [input.cwd] : [])];
  return paths.some(path => /\/orca\/workspaces\/[^/]+\/pacer-[^/]+-[^/]+(?:\/|$)/.test(resolve(path)));
}

export function plannerPolicyApplies(ctx: Ctx, planner: string, input?: unknown): boolean {
  if (isExecutorSession(ctx, input)) return false;
  try { return loadStrategy(ctx).planner === planner; }
  catch { return true; } // Preserve existing missing-strategy/fail-open behavior.
}

export function hookInput(stdin: string): unknown {
  try { return JSON.parse(stdin); } catch { return undefined; }
}
