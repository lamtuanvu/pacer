import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { type RepoInfo, realpathSafe } from "../core/git";
import type { Ctx } from "../types";

export interface TaskWorktree { path: string; workdir: string; branch: string; base: string }

export const taskWorktreesDir = (ctx: Ctx) => join(ctx.pacerHome, "worktrees");

/** <pacerHome>/worktrees/<repo name>-<8 hex of its real path>/<task-id>: stable per repo, readable, collision-free. */
export function taskWorktreePath(ctx: Ctx, top: string, taskId: string): string {
  const real = realpathSafe(top);
  const tag = `${basename(real).replace(/[^A-Za-z0-9._-]/g, "_")}-${createHash("sha1").update(real).digest("hex").slice(0, 8)}`;
  return join(taskWorktreesDir(ctx), tag, taskId);
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

export async function createTaskWorktree(ctx: Ctx, info: RepoInfo, taskId: string, base: string): Promise<TaskWorktree | { error: string }> {
  const path = taskWorktreePath(ctx, info.top, taskId), branch = `pacer/${taskId}`;
  const r = await ctx.run(["git", "-C", info.top, "worktree", "add", "-q", "-b", branch, path, base], 60_000);
  if (r.code !== 0) return { error: `git worktree add failed: ${firstLine(r.stderr) || `exit ${r.code}`}` };
  return { path, workdir: info.sub ? join(path, info.sub) : path, branch, base };
}

export async function worktreeDirty(ctx: Ctx, path: string): Promise<boolean | null> {
  const r = await ctx.run(["git", "-C", path, "status", "--porcelain"], 15_000);
  return r.code === 0 ? r.stdout.trim() !== "" : null;
}

/** Removes the worktree only; the pacer/<task-id> branch always stays. */
export async function removeTaskWorktree(ctx: Ctx, top: string, path: string, o: { force?: boolean } = {}): Promise<{ ok: true } | { error: string }> {
  const r = await ctx.run(["git", "-C", top, "worktree", "remove", ...(o.force ? ["--force"] : []), path], 60_000);
  return r.code === 0 ? { ok: true } : { error: `git worktree remove failed: ${firstLine(r.stderr) || `exit ${r.code}`}` };
}
