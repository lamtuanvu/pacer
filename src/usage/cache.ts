import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";

export interface Cached<T> { value: T | null; capturedAt: number | null; stale: boolean; error?: string }

/**
 * Cache a slow or remote reading under ~/.pacer/cache/<key>.json.
 * Fresh (< ttlS) hits skip the fetcher; on fetch failure a value younger than
 * maxStaleS is returned flagged stale; beyond that the error is returned.
 */
export async function cachedFetch<T>(
  ctx: Ctx, key: string, ttlS: number, maxStaleS: number, fetcher: () => Promise<T>,
): Promise<Cached<T>> {
  const path = join(ctx.pacerHome, "cache", `${key}.json`);
  const hit = readJson<{ capturedAt: number; value: T }>(path);
  if (hit && ctx.now - hit.capturedAt < ttlS) return { value: hit.value, capturedAt: hit.capturedAt, stale: false };
  try {
    const value = await fetcher();
    writeJsonAtomic(path, { capturedAt: ctx.now, value });
    return { value, capturedAt: ctx.now, stale: false };
  } catch (e) {
    const error = (e as Error).message;
    if (hit && ctx.now - hit.capturedAt < maxStaleS) {
      return { value: hit.value, capturedAt: hit.capturedAt, stale: true, error };
    }
    return { value: null, capturedAt: null, stale: false, error };
  }
}
