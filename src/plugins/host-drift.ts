import { statSync } from "node:fs";
import { type HostCfg } from "../config/hosts";
import { loadStrategy, MissingStrategyError, strategyPath, type Strategy } from "../config/strategy";
import type { Ctx } from "../types";

/** Pin the configured SSH target and only mappings named by this grant's arguments. */
export function hostFingerprint(host: HostCfg, args: readonly string[] = [], newWork = false): string {
  const used = new Set(args);
  return JSON.stringify({
    alias: host.alias, ssh: host.ssh, ...(newWork ? { paused: host.paused === true } : {}),
    repos: Object.fromEntries(Object.entries(host.repos).filter(([, path]) => used.has(path))),
    accounts: Object.fromEntries(Object.entries(host.accounts).filter(([, account]) => used.has(account.home))),
  });
}

/** Select the one configured checkout containing a persisted remote worktree. */
export function mappedRepoForPath(host: HostCfg, path: string): string | null {
  return Object.values(host.repos).filter(repo => path === repo || path.startsWith(`${repo}/`))
    .sort((a, b) => b.length - a.length)[0] ?? null;
}

/** Compare only the mapping keys captured when the grant was issued. */
export function matchesHostFingerprint(host: HostCfg, expected: string): boolean {
  try {
    const pinned = JSON.parse(expected) as { repos: Record<string, string>; accounts: Record<string, {home: string}>; paused?: boolean };
    return JSON.stringify({
      alias: host.alias, ssh: host.ssh, ...(Object.hasOwn(pinned, "paused") ? { paused: host.paused === true } : {}),
      repos: Object.fromEntries(Object.keys(pinned.repos).map(key => [key, host.repos[key]])),
      accounts: Object.fromEntries(Object.keys(pinned.accounts).map(key => [key, host.accounts[key]])),
    }) === expected;
  } catch { return false; }
}

const cache = new Map<string, { stamp: string; strategy: Strategy }>();
/** Watchers stat the selected file each tick, parsing YAML only after a change. */
export function cachedStrategy(ctx: Ctx): Strategy {
  const path = strategyPath(ctx);
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingStrategyError(path);
    throw error;
  }
  const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const entry = cache.get(path);
  if (entry?.stamp === stamp) return entry.strategy;
  const strategy = loadStrategy(ctx);
  cache.set(path, { stamp, strategy });
  return strategy;
}
