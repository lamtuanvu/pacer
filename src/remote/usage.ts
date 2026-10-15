import { join } from "node:path";
import type { AccountCfg } from "../config/accounts";
import type { HostCfg } from "../config/hosts";
import type { Ctx, UsageReading } from "../types";
import { readJson, writeJsonAtomic } from "../fsutil";
import { findRateLimits, windowsFromRateLimits } from "../usage/codex";
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
    const [header, ...lines] = result.stdout.trim().split("\n");
    if (!/^mtime=\d+(?:\.\d+)?$/.test(header)) return null;
    const mtime = Number(header.slice(6));
    const rl = findRateLimits(JSON.parse(lines.join("\n")));
    if (!rl) return null;
    const reading: UsageReading = { windows: windowsFromRateLimits(rl, mtime), capturedAt: mtime,
      stale: false, source: "session-log", remoteHost: host.alias };
    const previous = cachedRemoteUsage(ctx, account.name);
    if (!ctx.readOnly && (previous?.capturedAt == null || mtime > previous.capturedAt)) {
      writeJsonAtomic(cachePath(ctx, account.name), { reading, at: ctx.now });
    }
    return reading;
  } catch { return null; }
}
