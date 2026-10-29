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

/**
 * True when the task worktree has no uncommitted changes and no commits beyond base; null when git fails or no base is
 * known, since a clean tree may still hold commits.
 */
export async function worktreeUnchanged(ctx: Ctx, path: string, base: string | undefined): Promise<boolean | null> {
  const dirty = await worktreeDirty(ctx, path);
  if (dirty === null) return null;
  if (dirty) return false;
  if (!base) return null;
  const c = await ctx.run(["git", "-C", path, "rev-list", "--count", `${base}..HEAD`], 15_000);
  return c.code === 0 ? Number(c.stdout.trim()) === 0 : null;
}

/** Resolve once to an immutable commit; never silently use a stale local branch. */
export async function resolveWorktreeBase(ctx: Ctx, top: string, brief: { base?: string; worktreeBase?: "default" | "head" }, configured?: string | null, allowLocalHead = false): Promise<{ base: string; sha: string } | { error: string }> {
  let base = brief.base ?? (brief.worktreeBase === "head" ? "HEAD" : configured);
  // Automatic child placement must still work in local-only repositories.
  // Explicit new/default requests require origin; a failed fetch never falls back.
  if (!base && allowLocalHead && !brief.worktreeBase) {
    const origin = await ctx.run(["git", "-C", top, "remote"], 10_000);
    if (origin.code === 0 && !origin.stdout.trim().split(/\s+/).includes("origin")) base = "HEAD";
  }
  if (!base) {
    const fetched = await ctx.run(["git", "-C", top, "fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"], 60_000);
    if (fetched.code !== 0) return { error: `cannot fetch origin for worktree base: ${firstLine(fetched.stderr)}; use --worktree-base head to opt in to the current HEAD` };
    const remote = await ctx.run(["git", "-C", top, "ls-remote", "--symref", "origin", "HEAD"], 30_000);
    const branch = remote.code === 0 ? /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(remote.stdout)?.[1] : undefined;
    if (!branch) return { error: "cannot determine origin's default branch; use --worktree-base head or an explicit base" };
    base = `origin/${branch}`;
  }
  const commit = await ctx.run(["git", "-C", top, "rev-parse", "--verify", `${base}^{commit}`], 10_000);
  const sha = commit.stdout.trim();
  if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return { error: `cannot resolve worktree base ${base}: ${firstLine(commit.stderr)}` };
  return { base, sha };
}
