import { parseOrcaOutput } from "../exec/orca/client";
import { sanitizedOrcaEnv } from "../orca/env";
import type { Ctx } from "../types";
import { isObj } from "../util";

export async function selfHandle(ctx: Ctx): Promise<{ handle: string | null; paneKey: string | null; worktreeId?: string }> {
  // Orca 1.4.224 main bundle exports ORCA_TERMINAL_HANDLE, ORCA_PANE_KEY, and ORCA_WORKTREE_ID.
  // The terminal environment identifies this console even when another worktree is focused.
  const ownWorktree = ctx.env.ORCA_WORKTREE_ID ? { worktreeId: ctx.env.ORCA_WORKTREE_ID } : {};
  const paneKey = ctx.env.ORCA_PANE_KEY ?? null;
  const handle = ctx.env.ORCA_TERMINAL_HANDLE;
  if (handle && /^term_[A-Za-z0-9-]{1,100}$/.test(handle)) return { handle, paneKey, ...ownWorktree };
  if (!paneKey) return { handle: null, paneKey: null, ...ownWorktree };
  try {
    const r = await ctx.run(["orca", "terminal", "list", "--json"], 30_000, { env: sanitizedOrcaEnv(ctx.env) });
    const reply = parseOrcaOutput(r.stdout);
    if (r.code === 0 && isObj(reply) && reply.ok === true && isObj(reply.result) && Array.isArray(reply.result.terminals)) {
      const row = reply.result.terminals.find(row => isObj(row) && `${row.tabId}:${row.leafId}` === paneKey);
      if (isObj(row) && typeof row.handle === "string") return { handle: row.handle, paneKey, ...(typeof row.worktreeId === "string" ? { worktreeId: row.worktreeId } : {}), ...ownWorktree };
    }
  } catch { /* An ordinary terminal can still run the console. */ }
  return { handle: null, paneKey, ...ownWorktree };
}

export async function resolveWorktreePath(ctx: Ctx, branch: string, worktreeId?: string): Promise<string | null> {
  const selectors = [...(worktreeId ? [`id:${worktreeId}`] : []), ...(branch ? [`branch:${branch}`] : [])];
  for (const selector of selectors) {
    try {
      const r = await ctx.run(["orca", "worktree", "show", "--worktree", selector, "--json"], 30_000, { env: sanitizedOrcaEnv(ctx.env) });
      const reply = parseOrcaOutput(r.stdout);
      if (r.code === 0 && isObj(reply) && reply.ok === true && isObj(reply.result) && isObj(reply.result.worktree) && typeof reply.result.worktree.path === "string") return reply.result.worktree.path;
    } catch { /* Try the branch for hosts that cannot resolve the id. */ }
  }
  return null;
}
