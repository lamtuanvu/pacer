import { join } from "node:path";
import type { AccountCfg } from "../config/accounts";
import type { HostCfg } from "../config/hosts";
import type { Ctx, UsageReading } from "../types";
import { readJson, writeJsonAtomic } from "../fsutil";
import { rateLimitObservation, readingFromObservation } from "../usage/codex";
import { SCRIPTS } from "./scripts";
import { runRemote } from "./ssh";

const cachePath = (ctx: Ctx, account: string) => join(ctx.pacerHome, "cache", "remote-usage", `${account}.json`);

/** Cache reads never contact hosts, and a missing or damaged cache is no data. */
export function cachedRemoteUsage(ctx: Ctx, account: string): UsageReading | null {
  try {
    const { reading } = readJson<{ reading: UsageReading }>(cachePath(ctx, account)) ?? {};
    return reading && Number.isFinite(reading.capturedAt) && Array.isArray(reading.windows)
      && typeof reading.remoteHost === "string" ? reading : null;
  } catch { return null; }
}

/** Passive Codex usage only; SSH or parse failures must never fail a task or host check. */
export async function probeCodexUsage(ctx: Ctx, host: HostCfg, account: AccountCfg): Promise<UsageReading | null> {
  if (account.kind !== "codex") return null;
  try {
    const home = host.accounts[account.name]?.home;
    const result = await runRemote(ctx, host, SCRIPTS.CODEX_USAGE, home ? [home] : []);
    if (result.code !== 0) return null;
    const observations = result.stdout.trim().split("\n").flatMap(line => {
      try { const value = rateLimitObservation(JSON.parse(line)); return value ? [value] : []; } catch { return []; }
    }).filter(value => value.observedAt !== null && value.observedAt <= ctx.now)
      .sort((a, b) => b.observedAt! - a.observedAt!);
    if (!observations.length) return null;
    const reading: UsageReading = { ...readingFromObservation(observations[0]), remoteHost: host.alias };
    const previous = cachedRemoteUsage(ctx, account.name);
    if (!ctx.readOnly && (previous?.capturedAt == null || reading.capturedAt! > previous.capturedAt)) {
      writeJsonAtomic(cachePath(ctx, account.name), { reading, at: ctx.now });
    }
    return reading;
  } catch { return null; }
}
