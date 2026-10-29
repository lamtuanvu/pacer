import { lstat } from "node:fs/promises";
import { z } from "zod";
import { openReadOnlyStore, runningTasksReadOnly } from "../dispatch/readonly";
import { isExecutorSession } from "../install/role";
import { CoreError } from "./errors";
import { listRepos } from "./repos";
import { progressBase, type TaskRecord } from "../tasks/types";
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
  cacheMs: 5000, cacheEntries: 64, changedTasks: 8, changedMs: 1000, changedBytes: 1024 * 1024,
  yieldEvery: 5000, keepHits: 1000,
} as const;

interface Listing { paths: string[]; state: RepoScanState }
type ChangedPaths = string[] | null;
interface Cached<T> { at: number; value: Promise<T> }
// In-memory only: repeated keystrokes reuse a recent (or in-flight) git read instead of spawning git again.
const listings = new Map<string, Cached<Listing>>();
const changedPaths = new Map<string, Cached<ChangedPaths>>();
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
export function clearFilesSearchCache(): void {
  listings.clear(); changedPaths.clear();
  clearTimeout(sweepTimer); sweepTimer = undefined;
}
/** Test hook: the number of cached git reads still held. */
export function filesSearchCacheSize(): number { return listings.size + changedPaths.size; }

function sweep(now = Date.now()): void {
  for (const cache of [listings, changedPaths])
    for (const [key, entry] of cache) if (now - entry.at >= FILES_SEARCH_LIMITS.cacheMs) cache.delete(key);
}
/** Entries expire after the TTL (swept on every read and by an unref'd timer) and the oldest go first past the size bound. */
function cached<T>(cache: Map<string, Cached<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  sweep(now);
  const hit = cache.get(key);
  if (hit) return hit.value;
  const value = load();
  cache.set(key, { at: now, value });
  while (cache.size > FILES_SEARCH_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!);
  armSweep();
  return value;
}
function armSweep(): void {
  if (sweepTimer || !(listings.size || changedPaths.size)) return;
  sweepTimer = setTimeout(() => { sweepTimer = undefined; sweep(); armSweep(); }, FILES_SEARCH_LIMITS.cacheMs);
  (sweepTimer as { unref?: () => void }).unref?.();
}

/** Git sees only what it needs to run: no inherited `GIT_*` (such as `GIT_DIR`) and no service secrets. */
function gitEnv(ctx: Ctx): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(ctx.env))
    if (value !== undefined && (["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"].includes(name) || name.startsWith("LC_"))) env[name] = value;
  return env;
}

/** A git path is kept only when it is relative, has no `.`/`..`/empty segment and is not inside `.git`. */
export function safeRepoPath(path: string): boolean {
  if (!path || path.includes("\0") || path.startsWith("/") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts[0] !== ".git" && parts.every(p => p !== "" && p !== "." && p !== "..");
}

function listTracked(ctx: Ctx, root: string): Promise<Listing> {
  return cached(listings, root, async () => {
    try {
      // The query never reaches git; fsmonitor is off so listing cannot start a repository-configured hook.
      // Output past the byte cap stops the process instead of being buffered.
      const r = await ctx.run(["git", "-c", "core.fsmonitor=false", "-C", root, "ls-files", "-z", "--cached"], FILES_SEARCH_LIMITS.listMs, { env: gitEnv(ctx), maxStdoutBytes: FILES_SEARCH_LIMITS.listBytes });
      if (r.timedOut) return { paths: [], state: "timeout" };
      const tooBig = r.stdoutOverflow || r.stdout.length > FILES_SEARCH_LIMITS.listBytes;
      if (r.code !== 0 && !r.stdoutOverflow) return { paths: [], state: "error" };
      const raw = (tooBig ? r.stdout.slice(0, r.stdout.lastIndexOf("\0", FILES_SEARCH_LIMITS.listBytes) + 1) : r.stdout).split("\0");
      const capped = raw.length - 1 > FILES_SEARCH_LIMITS.listPaths;
      const paths = raw.slice(0, FILES_SEARCH_LIMITS.listPaths).filter(safeRepoPath);
      return { paths, state: tooBig || capped ? "too_large" : "ok" };
    } catch { return { paths: [], state: "error" }; }
  });
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
    const base = progressBase(task);
    const argv = ["git", "-c", "core.fsmonitor=false", "--literal-pathspecs", "-C", worktree, "diff", ...(base ? ["--merge-base"] : []), "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--end-of-options", base ?? "HEAD", "--"];
    const paths = await cached(changedPaths, JSON.stringify([task.id, worktree, base]), async () => {
      try {
        const r = await ctx.run(argv, FILES_SEARCH_LIMITS.changedMs, { env: gitEnv(ctx), maxStdoutBytes: FILES_SEARCH_LIMITS.changedBytes });
        return r.timedOut || r.code !== 0 || r.stdoutOverflow ? null : r.stdout.split("\0").filter(safeRepoPath);
      } catch { return null; }
    });
    if (!paths) return;
    const byPath = out.get(task.repo!.key) ?? new Map<string, { task: string; title?: string }[]>();
    out.set(task.repo!.key, byPath);
    for (const path of paths) {
      const list = byPath.get(path) ?? [];
      list.push({ task: task.id, ...(task.title ? { title: task.title } : {}) });
      byPath.set(path, list);
    }
  }));
  return out;
}

/**
 * Size of a regular file reached from `root` without following any symlink below it: every
 * intermediate segment must be a real directory, so a tracked directory swapped for a symlink
 * cannot turn `size` into a stat of a file outside the repository. (No realpath: serve avoids it.)
 */
export async function sizeInside(root: string, path: string): Promise<number | undefined> {
  if (!safeRepoPath(path)) return undefined;
  const parts = path.split("/");
  try {
    let at = root, size = 0;
    for (const [i, part] of parts.entries()) {
      at = `${at}/${part}`;
      const s = await lstat(at);
      if (i < parts.length - 1 ? !s.isDirectory() : !s.isFile()) return undefined;
      size = s.size;
    }
    return size;
  } catch { return undefined; }
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
  type Hit = FileMatch & { tier: number; root: string };
  const order = (a: Hit, b: Hit) => a.tier - b.tier || Number(!a.changedBy) - Number(!b.changedBy) || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.repo < b.repo ? -1 : 1);
  // Only the best `limit` hits are kept, so a one-letter query over millions of paths holds a bounded array,
  // and the loop yields to the event loop every few thousand paths so other requests are not stalled.
  let hits: Hit[] = [], total = 0, seen = 0;
  for (const [i, r] of scanned.entries()) {
    const touched = changed.get(r.key);
    for (const path of listed[i].paths) {
      if (++seen % FILES_SEARCH_LIMITS.yieldEvery === 0) await new Promise<void>(done => setImmediate(done));
      const m = matchPath(path, query);
      if (!m) continue;
      total++;
      const changedBy = touched?.get(path);
      hits.push({ repo: r.key, repoLabel: r.label, path, ranges: m.ranges, tier: m.tier, root: r.path, ...(changedBy ? { changedBy } : {}) });
      if (hits.length >= FILES_SEARCH_LIMITS.keepHits) hits = hits.sort(order).slice(0, limit);
    }
  }
  hits.sort(order);
  const results = await Promise.all(hits.slice(0, limit).map(async ({ tier: _, root, ...hit }) => {
    const size = await sizeInside(root, hit.path);
    return size === undefined ? hit : { ...hit, size };
  }));
  return {
    query, results, truncated: total > limit,
    repos: repos.map(r => ({ key: r.key, state: states.get(r.key) ?? "skipped" })),
  };
}
