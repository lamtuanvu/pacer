import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import { withLockSync } from "../core/lock";
import type { AccountCfg } from "../config/accounts";
import type { HostCfg } from "../config/hosts";
import { validateStrategy } from "../config/strategy";
import { accountEvidenceScope } from "../evidence/scope";
import type { Ctx, UsageReading } from "../types";
import { EVIDENCE_PRUNE_AFTER_S, markFreshness } from "./freshness";

/** Rewrite a fresh, unchanged reading this long before it would turn stale, so cold readers never see it lapse. */
const REFRESH_AHEAD_S = 600;

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
    // Entries for superseded source keys (an edited model or budget) age out instead of accumulating.
    const entries = Object.fromEntries(Object.entries(saved?.entries ?? {}).filter(([k, e]) => k === key || e.savedAt > ctx.now - EVIDENCE_PRUNE_AFTER_S));
    const previous = entries[key]?.reading;
    const sameShape = (r: UsageReading) => JSON.stringify([r.windows, r.error ?? null, r.availability ?? null, r.source ?? null, r.stale]);
    // A repeated failure keeps the same stale last-good reading; a fresh one is rewritten shortly before it lapses.
    if (previous && sameShape(previous) === sameShape(reading) && (reading.stale || !markFreshness(previous, ctx.now + REFRESH_AHEAD_S).stale)) return;
    entries[key] = { savedAt: ctx.now, reading };
    writeJsonAtomic(path, { schemaVersion: SCHEMA_VERSION, identity, entries });
  });
}

/** Account removal starts the identity over; nothing may outlive the lifetime boundary. */
export function deleteUsageStore(ctx: Ctx, identity: string): void {
  if (ctx.readOnly) return;
  withLockSync(ctx, `usage-store:${identity}`, () => {
    try { unlinkSync(usagePath(ctx, identity)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  });
}

/** Evidence identities of every configured account (including host-scoped homes). */
export function configuredUsageIdentities(
  accounts: Record<string, AccountCfg>,
  hosts: Record<string, HostCfg> = {},
): Set<string> {
  return new Set(Object.values(accounts).map(account => accountEvidenceScope(account, hosts).identity));
}

/** Identities owned by any strategy file under the pacer home (active or inactive). */
export function usageIdentitiesInHome(ctx: Ctx): Set<string> {
  const keep = new Set<string>();
  const paths = [join(ctx.pacerHome, "strategy.yaml")];
  const dir = join(ctx.pacerHome, "strategies");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".yaml")) paths.push(join(dir, name));
    }
  }
  for (const path of paths) {
    try {
      const strategy = validateStrategy(Bun.YAML.parse(readFileSync(path, "utf8")), path);
      for (const id of configuredUsageIdentities(strategy.accounts, strategy.hosts)) keep.add(id);
    } catch { /* Missing or invalid strategies do not block prune of true orphans. */ }
  }
  return keep;
}

/**
 * Delete `state/usage/<identity>.json` files no configured account still owns.
 * Call on service start and after edits that change evidence identity (home, usage
 * source, hosts). Returns the identities that were removed.
 */
export function pruneOrphanUsageStores(ctx: Ctx, keep: ReadonlySet<string> = usageIdentitiesInHome(ctx)): string[] {
  if (ctx.readOnly) return [];
  const dir = join(ctx.pacerHome, "state", "usage");
  let names: string[];
  try { names = readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const identity = name.slice(0, -".json".length);
    if (keep.has(identity)) continue;
    try {
      withLockSync(ctx, `usage-store:${identity}`, () => {
        unlinkSync(join(dir, name));
      });
      removed.push(identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}
