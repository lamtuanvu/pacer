import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import { withLockSync } from "../core/lock";
import type { Ctx, UsageReading } from "../types";
import { markFreshness } from "./freshness";

const SCHEMA_VERSION = 1;
const usagePath = (ctx: Ctx, identity: string) => join(ctx.pacerHome, "state", "usage", `${identity}.json`);

interface UsageStoreFile { schemaVersion: 1; identity: string; entries: Record<string, { savedAt: number; reading: UsageReading }> }
const validFile = (saved: UsageStoreFile | null, identity: string): UsageStoreFile | null =>
  saved?.schemaVersion === SCHEMA_VERSION && saved.identity === identity && saved.entries && typeof saved.entries === "object"
    ? saved : null;

/** One cached reading of an account's usage source, keyed inside the identity file. */
export function readUsageEntry(ctx: Ctx, identity: string, key: string): UsageReading | null {
  const entry = validFile(readJson<UsageStoreFile>(usagePath(ctx, identity)), identity)?.entries[key];
  return entry && Number.isFinite(entry.savedAt) && entry.reading && Array.isArray(entry.reading.windows) ? entry.reading : null;
}

/**
 * Persist a reading under the account's evidence identity, guarded by the per-identity
 * usage-store lock. A write happens when the windows, error, availability or source change,
 * or when the stored reading is older than its freshness cap; a new capturedAt alone
 * never rewrites the file.
 */
export function writeUsageEntry(ctx: Ctx, identity: string, key: string, reading: UsageReading): void {
  if (ctx.readOnly) return;
  withLockSync(ctx, `usage-store:${identity}`, () => {
    const path = usagePath(ctx, identity);
    const saved = validFile(readJson<UsageStoreFile>(path), identity);
    const entries = saved?.entries ?? {};
    const previous = entries[key]?.reading;
    const sameShape = (r: UsageReading) => JSON.stringify([r.windows, r.error ?? null, r.availability ?? null, r.source ?? null]);
    if (previous && !markFreshness(previous, ctx.now).stale && sameShape(previous) === sameShape(reading)) return;
    entries[key] = { savedAt: ctx.now, reading };
    writeJsonAtomic(path, { schemaVersion: SCHEMA_VERSION, identity, entries });
  });
}

/** Account removal starts the identity over; nothing may outlive the lifetime boundary. */
export function deleteUsageStore(ctx: Ctx, identity: string): void {
  if (ctx.readOnly) return;
  try { unlinkSync(usagePath(ctx, identity)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
