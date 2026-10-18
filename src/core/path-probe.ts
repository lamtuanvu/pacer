import * as fsp from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Raw filesystem calls still running, by op and path. A deadline only stops waiting: the call itself
 * stays in the threadpool until macOS (e.g. a removable-volume privacy prompt) or the volume answers.
 * Reuse a stuck call instead of issuing another, and report the oldest as service.waiting.
 */
const inflight = new Map<string, { path: string; since: number; promise: Promise<unknown> }>();
function tracked<T>(op: string, path: string, work: () => Promise<T>): Promise<T> {
  const p = resolve(path), id = `${op}\0${p}`, running = inflight.get(id);
  if (running) return running.promise as Promise<T>;
  const promise = Promise.resolve().then(work).finally(() => { inflight.delete(id); });
  inflight.set(id, { path: p, since: Date.now(), promise });
  return promise;
}
/** Read-only fs calls on repo paths; identical calls share one in-flight operation. */
export const repoFs = {
  access: (path: string) => tracked("access", path, () => fsp.access(path)),
  realpath: (path: string) => tracked("realpath", path, () => fsp.realpath(path)),
  stat: (path: string) => tracked("stat", path, () => fsp.stat(path)),
  lstat: (path: string) => tracked("lstat", path, () => fsp.lstat(path)),
  readFile: (path: string) => tracked("readFile", path, () => fsp.readFile(path)),
  readText: (path: string) => tracked("readText", path, () => fsp.readFile(path, "utf8")),
  readdir: (path: string) => tracked("readdir", path, () => fsp.readdir(path)),
};
export interface Waiting { kind: "volume" | "folder"; path: string; since: number }
export const WAITING_AFTER_MS = 1000;
/** The oldest repo-path call outstanding for at least a second, as a volume root under /Volumes. */
export function stuckIO(now = Date.now()): { path: string; since: number }[] {
  return [...inflight.values()].filter(entry => now - entry.since >= WAITING_AFTER_MS).sort((a, b) => a.since - b.since);
}
export function waitingIO(now = Date.now()): Waiting | undefined {
  const oldest = stuckIO(now)[0];
  return oldest && waitingFor(oldest.path, oldest.since);
}
export function waitingFor(path: string, sinceMs: number): Waiting {
  const parts = path.split(sep);
  const volume = parts[1] === "Volumes" && parts[2] ? `${sep}Volumes${sep}${parts[2]}` : null;
  return { kind: volume ? "volume" : "folder", path: volume ?? path, since: Math.floor(sinceMs / 1000) };
}

export interface PathProbe { exists?: boolean; real: string; checkedAt: number; unreachable?: true }
export const pathProbeIO = { access: (path: string) => repoFs.access(path), realpath: (path: string) => repoFs.realpath(path) };
const cache = new Map<string, PathProbe>();
const pending = new Map<string, Promise<PathProbe>>();
const retryAt = new Map<string, number>();
const REFRESH_MS = 60_000;

/** Bound even injected implementations that ignore their own timeout. */
export async function withTimeout<T>(work: () => Promise<T>, timeoutMs = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("path operation timed out")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function rememberPath(path: string, real: string): void {
  cache.set(resolve(path), { exists: true, real, checkedAt: Date.now() });
}

export function markPathUnreachable(path: string): void {
  const p = resolve(path);
  cache.set(p, { ...cachedPath(p), checkedAt: Date.now(), unreachable: true });
}

/** Cache only: missing descendants can inherit a previously canonicalized parent. */
export function cachedPath(path: string): PathProbe {
  const p = resolve(path);
  const known = cache.get(p);
  if (known) return known;
  let parent = dirname(p);
  while (true) {
    const ancestor = cache.get(parent);
    if (ancestor) return { real: join(ancestor.real, relative(parent, p)), checkedAt: 0 };
    if (dirname(parent) === parent) break;
    parent = dirname(parent);
  }
  return { real: p, checkedAt: 0 };
}

/** Errors/timeouts preserve the last observation; only ENOENT/ENOTDIR mean absent. */
export function refreshPath(path: string, timeoutMs = 2000): Promise<PathProbe> {
  const p = resolve(path), active = pending.get(p);
  if (active) return active;
  retryAt.set(p, Date.now() + REFRESH_MS);
  const work = (async () => {
    try {
      await withTimeout(() => pathProbeIO.access(p), timeoutMs);
      const real = await withTimeout(() => pathProbeIO.realpath(p), timeoutMs);
      cache.set(p, { exists: true, real, checkedAt: Date.now() });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        const parent = dirname(p);
        if (parent !== p) await refreshPath(parent, timeoutMs);
        cache.set(p, { exists: false, real: cachedPath(p).real, checkedAt: Date.now() });
      } else {
        markPathUnreachable(p);
      }
    }
    return cachedPath(p);
  })().finally(() => { pending.delete(p); });
  pending.set(p, work);
  return work;
}

export function schedulePathRefresh(path: string): void {
  const p = resolve(path);
  if (Date.now() >= (retryAt.get(p) ?? 0)) void refreshPath(p);
}

const texts = new Map<string, string | null>();
const textRefreshAt = new Map<string, number>();
/** Read-side metadata is stale-while-revalidate, just like path identity. */
export function cachedText(path: string): string | null {
  const p = resolve(path), now = Date.now();
  if (now >= (textRefreshAt.get(p) ?? 0)) {
    textRefreshAt.set(p, now + REFRESH_MS);
    void withTimeout(() => repoFs.readText(p)).then(text => {
      texts.set(p, text);
      rememberPath(p, cachedPath(p).real);
    }).catch(error => {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) texts.set(p, null);
      else markPathUnreachable(p);
    });
  }
  return texts.get(p) ?? null;
}

const directories = new Map<string, string[]>();
const directoryRefreshAt = new Map<string, number>();
export function cachedDirectory(path: string): string[] {
  const p=resolve(path), now=Date.now();
  if (now >= (directoryRefreshAt.get(p) ?? 0)) {
    directoryRefreshAt.set(p,now+REFRESH_MS);
    void withTimeout(() => repoFs.readdir(p)).then(names => directories.set(p,names)).catch(error => {
      if (["ENOENT","ENOTDIR"].includes(error?.code)) directories.set(p,[]);
      else markPathUnreachable(p);
    });
  }
  return directories.get(p) ?? [];
}
