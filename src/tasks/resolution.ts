import { autoCleanTask } from "./cleanup";
import { createHash } from "node:crypto";
import { boundedGitRead } from "../core/git";
import { repoFs, withTimeout } from "../core/path-probe";
import { join } from "node:path";
import type { Ctx } from "../types";
import { loadStrategy } from "../config/strategy";
import { validateExecution } from "../config/execution";
import { readTask, updateTask, withTaskLock } from "./store";
import type { TaskRecord } from "./types";

async function exists(path: string): Promise<boolean> {
  try { await withTimeout(() => repoFs.access(path)); return true; }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
/** Compare committed and untracked bytes. Failed or timed-out reads never resolve work. */
export async function resolutionReason(ctx: Ctx, t: TaskRecord, timeoutMs?: number): Promise<string | null> {
  if (t.review) return "reviewed";
  try { return await (timeoutMs === undefined ? compareWorktree(ctx, t) : withTimeout(() => compareWorktree(ctx, t), timeoutMs)); }
  catch { return null; }
}
async function compareWorktree(ctx: Ctx, t: TaskRecord): Promise<string | null> {
  const worktree = t.result?.worktree ?? t.worktree;
  if (!worktree) return null;
  if (!await exists(worktree)) return "worktree removed";
  if (t.placement?.mode === "current") return null;
  const [workerReal, repoReal] = await Promise.all([withTimeout(() => repoFs.realpath(worktree)), withTimeout(() => repoFs.realpath(t.brief.repo))]);
  if (workerReal === repoReal) return null;
  let root = worktree;
  const runGit = async (dir: string, ...args: string[]) => {
    const result = await boundedGitRead(ctx.run, ["git", "-C", dir, ...args], 2000);
    if (result.code !== 0) throw new Error("git comparison failed");
    return result.stdout;
  };
  const git = (...args: string[]) => runGit(root, ...args);
  root = (await git("rev-parse", "--show-toplevel")).trim();
  let base = t.baseBranch;
  if (!base) { try { base = validateExecution(loadStrategy(ctx).execution).baseBranch ?? undefined; } catch {} }
  base ??= (await runGit(t.brief.repo, "symbolic-ref", "--short", "HEAD")).trim();
  const tip = (await git("rev-parse", "--verify", `${base}^{commit}`)).trim();
  const ancestor = (await git("merge-base", "HEAD", tip)).trim();
  const paths = new Set([
    ...(await git("diff", "--name-only", "-z", ancestor, "--")).split("\0"),
    ...(await git("ls-files", "--others", "--exclude-standard", "-z")).split("\0"),
  ].filter(Boolean));
  if (!paths.size) return null;
  // ctx.run returns text. Compare blob hashes to preserve arbitrary binary bytes.
  const format = (await git("rev-parse", "--show-object-format")).trim();
  if (!["sha1", "sha256"].includes(format)) return null;
  for (const path of paths) {
    const tree = await git("ls-tree", "-z", tip, "--", path);
    const expected = tree ? /^\d+ blob ([a-f0-9]+)\t/.exec(tree)?.[1] : null;
    if (tree && !expected) return null;
    const file = join(root, path);
    if (!await exists(file)) { if (expected) return null; continue; }
    if (!expected) return null;
    const bytes = await withTimeout(() => repoFs.readFile(file));
    const hash = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (hash !== expected) return null;
  }
  return `already on ${base}`;
}
const checkedAt = new Map<string, number>();

export async function resolveTask(ctx: Ctx, t: TaskRecord): Promise<TaskRecord> {
  if (t.resolved || !["partial", "failed"].includes(t.state)) return t;
  const key = `${ctx.pacerHome}/${t.id}`, last = checkedAt.get(key);
  if (!t.review && last !== undefined && ctx.now >= last && ctx.now - last < 60) return t;
  checkedAt.set(key, ctx.now);
  const reason = await resolutionReason(ctx, t);
  const result = withTaskLock(ctx, t.id, () => {
    const current = readTask(ctx, t.id);
    if (!current) return {...t, ...(reason ? {resolved: reason} : {})};
    const resolved = current.review ? "reviewed" : current.resolved ||
      (["partial", "failed"].includes(current.state) ? reason : null);
    const updated = resolved && resolved !== current.resolved
      ? updateTask(ctx, t.id, x => {x.resolved = resolved;})
      : current;
    // Pump dependencies may supply newer presentation metadata. Preserve it
    // unless a concurrent writer advanced the task while comparison awaited IO.
    return current.rev > t.rev ? updated : {...t,
      ...(updated.resolved ? {resolved: updated.resolved} : {}),
      ...(updated.review ? {review: updated.review} : {})};
  });
  if (result.resolved && !t.resolved) await autoCleanTask(ctx, t.id);
  return result;
}
