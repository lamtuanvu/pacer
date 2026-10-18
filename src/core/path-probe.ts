import { access, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export interface PathProbe { exists?: boolean; real: string; checkedAt: number }
export const pathProbeIO = { access: (path: string) => access(path), realpath: (path: string) => realpath(path) };
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
