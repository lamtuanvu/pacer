import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { openReadOnlyStore, runningTasksReadOnly } from "../dispatch/readonly";
import { isExecutorSession } from "../install/role";
import { CoreError } from "./errors";
import { listRepos } from "./repos";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";

export const filesSearchInputSchema = z.strictObject({
  query: z.string().min(1).max(200),
  repo: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type FilesSearchInput = z.input<typeof filesSearchInputSchema>;

export interface FileMatch {
  repo: string; repoLabel: string; path: string; size?: number;
  ranges: [number, number][];
  changedBy?: { task: string; title?: string }[];
}
export type RepoScanState = "ok" | "skipped" | "timeout" | "too_large" | "error";
export interface FilesSearchResult {
  query: string; results: FileMatch[]; truncated: boolean;
  repos: { key: string; state: RepoScanState }[];
}

export const FILES_SEARCH_LIMITS = {
  repos: 20, defaultLimit: 20, listMs: 2000, listBytes: 8 * 1024 * 1024, listPaths: 200_000,
  cacheMs: 5000, changedTasks: 8, changedMs: 1000,
} as const;

interface Listing { paths: string[]; state: RepoScanState; at: number }
// In-memory only: repeated keystrokes reuse a recent listing instead of spawning git again.
const listings = new Map<string, Listing>();
export function clearFilesSearchCache(): void { listings.clear(); }

/** A git path is kept only when it is relative, has no `.`/`..`/empty segment and is not inside `.git`. */
export function safeRepoPath(path: string): boolean {
  if (!path || path.includes("\0") || path.startsWith("/") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts[0] !== ".git" && parts.every(p => p !== "" && p !== "." && p !== "..");
}

async function listTracked(ctx: Ctx, root: string): Promise<Listing> {
  const at = Date.now(), cached = listings.get(root);
  if (cached && at - cached.at < FILES_SEARCH_LIMITS.cacheMs) return cached;
  let listing: Listing;
  try {
    // The query never reaches git; fsmonitor is off so listing cannot start a repository-configured hook.
    const r = await ctx.run(["git", "-c", "core.fsmonitor=false", "-C", root, "ls-files", "-z", "--cached"], FILES_SEARCH_LIMITS.listMs);
    if (r.timedOut) listing = { paths: [], state: "timeout", at };
    else if (r.code !== 0) listing = { paths: [], state: "error", at };
    else {
      const tooBig = r.stdout.length > FILES_SEARCH_LIMITS.listBytes;
      const raw = (tooBig ? r.stdout.slice(0, r.stdout.lastIndexOf("\0", FILES_SEARCH_LIMITS.listBytes) + 1) : r.stdout).split("\0");
      const capped = raw.length - 1 > FILES_SEARCH_LIMITS.listPaths;
      const paths = raw.slice(0, FILES_SEARCH_LIMITS.listPaths).filter(safeRepoPath);
      listing = { paths, state: tooBig || capped ? "too_large" : "ok", at };
    }
  } catch { listing = { paths: [], state: "error", at }; }
  listings.set(root, listing);
  return listing;
}

interface Scored { tier: number; ranges: [number, number][] }
/** Basename substring, then path substring, then an in-order subsequence of the query's characters. */
export function matchPath(path: string, query: string): Scored | null {
  const lower = path.toLowerCase(), q = query.toLowerCase();
  const base = lower.lastIndexOf("/") + 1, inBase = lower.indexOf(q, base);
  if (inBase >= 0) return { tier: 0, ranges: [[inBase, inBase + q.length]] };
  const inPath = lower.indexOf(q);
  if (inPath >= 0) return { tier: 1, ranges: [[inPath, inPath + q.length]] };
  const chars = q.replace(/\s+/g, "");
  if (!chars) return null;
  const ranges: [number, number][] = [];
  let i = 0;
  for (let at = 0; at < lower.length && i < chars.length; at++) {
    if (lower[at] !== chars[i]) continue;
    const last = ranges.at(-1);
    if (last && last[1] === at) last[1] = at + 1; else ranges.push([at, at + 1]);
    i++;
  }
  return i === chars.length ? { tier: 2, ranges } : null;
}

/** Paths changed in the worktrees of running local tasks, keyed by repository key. Failures drop the annotation. */
async function changedByRunningTasks(ctx: Ctx, keys: Set<string>): Promise<Map<string, Map<string, { task: string; title?: string }[]>>> {
  const out = new Map<string, Map<string, { task: string; title?: string }[]>>();
  const store = openReadOnlyStore(ctx);
  let running: TaskRecord[];
  try { running = runningTasksReadOnly(store); } finally { store.close(); }
  const local = running.filter(t => !t.run?.host && t.repo && keys.has(t.repo.key)).slice(0, FILES_SEARCH_LIMITS.changedTasks);
  await Promise.all(local.map(async task => {
    const worktree = task.run?.workdir ?? task.worktree ?? task.result?.worktree ?? task.brief.repo;
    if (!worktree?.startsWith("/")) return;
    const base = task.run?.mode === "new" ? task.baseSha ?? task.baseBranch ?? null : null;
    const argv = ["git", "-c", "core.fsmonitor=false", "--literal-pathspecs", "-C", worktree, "diff", ...(base ? ["--merge-base"] : []), "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--end-of-options", base ?? "HEAD", "--"];
    try {
      const r = await ctx.run(argv, FILES_SEARCH_LIMITS.changedMs);
      if (r.timedOut || r.code !== 0) return;
      const byPath = out.get(task.repo!.key) ?? new Map<string, { task: string; title?: string }[]>();
      out.set(task.repo!.key, byPath);
      for (const path of r.stdout.split("\0").filter(safeRepoPath)) {
        const list = byPath.get(path) ?? [];
        list.push({ task: task.id, ...(task.title ? { title: task.title } : {}) });
        byPath.set(path, list);
      }
    } catch { /* annotation only */ }
  }));
  return out;
}

/**
 * Read-only file path search over the repositories registered with pacer, for the app's command menu.
 * Lists tracked files with `git ls-files` (argument vector, bounded), never passes the query to a
 * subprocess and never returns a path outside the repository root. Writes nothing.
 */
export async function searchFiles(ctx: Ctx, input: unknown): Promise<FilesSearchResult> {
  const parsed = filesSearchInputSchema.safeParse(input);
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid files search input", parsed.error.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  if (isExecutorSession(ctx) || ctx.env.PACER_WORK_GRANT) throw new CoreError("not_allowed", "File search is not available to executor sessions");
  const query = parsed.data.query.trim();
  if (!query) throw new CoreError("invalid_input", "query must not be blank");
  const limit = parsed.data.limit ?? FILES_SEARCH_LIMITS.defaultLimit;
  ctx = { ...ctx, readOnly: true };
  // No task-store read here: recent tasks only shield registry entries from pruning, which read-only skips.
  let repos = listRepos(ctx, []);
  if (parsed.data.repo !== undefined) {
    repos = repos.filter(r => r.key === parsed.data.repo);
    if (!repos.length) throw new CoreError("invalid_input", `Unknown repository "${parsed.data.repo}"`, "Use a key from repo.list.");
  }
  repos = repos.slice(0, FILES_SEARCH_LIMITS.repos);
  const scanned = repos.filter(r => !r.unreachable);
  const [listed, changed] = await Promise.all([
    Promise.all(scanned.map(r => listTracked(ctx, r.path))),
    changedByRunningTasks(ctx, new Set(scanned.map(r => r.key))),
  ]);
  const states = new Map(scanned.map((r, i) => [r.key, listed[i].state]));
  const hits: (FileMatch & { tier: number; root: string })[] = [];
  scanned.forEach((r, i) => {
    const touched = changed.get(r.key);
    for (const path of listed[i].paths) {
      const m = matchPath(path, query);
      if (!m) continue;
      const changedBy = touched?.get(path);
      hits.push({ repo: r.key, repoLabel: r.label, path, ranges: m.ranges, tier: m.tier, root: r.path, ...(changedBy ? { changedBy } : {}) });
    }
  });
  hits.sort((a, b) => a.tier - b.tier || Number(!a.changedBy) - Number(!b.changedBy) || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.repo < b.repo ? -1 : 1));
  const results = await Promise.all(hits.slice(0, limit).map(async ({ tier: _, root, ...hit }) => {
    try {
      const s = await lstat(join(root, hit.path));
      return s.isFile() ? { ...hit, size: s.size } : hit;
    } catch { return hit; }
  }));
  return {
    query, results, truncated: hits.length > limit,
    repos: repos.map(r => ({ key: r.key, state: states.get(r.key) ?? "skipped" })),
  };
}
