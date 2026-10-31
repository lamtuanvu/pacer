import { accountEvidenceScope } from "../evidence/scope";
import { join } from "node:path";
import type { AccountCfg } from "../config/accounts";
import type { HostCfg } from "../config/hosts";
import type { Ctx, UsageReading } from "../types";
import { readJson, writeJsonAtomic } from "../fsutil";
import { rateLimitObservation, readingFromObservation } from "../usage/codex";
import { pluginRegistry } from "../plugins";
import { issueConfiguredRemoteUsage } from "../plugins/remote-usage-issuer";
import { HOST_RUNNER_METHODS } from "../plugins/host-runner-protocol";

const cachePath = (ctx: Ctx, account: string) => join(ctx.pacerHome, "cache", "remote-usage", `${account}.json`);
const origin = (host: HostCfg, account: AccountCfg) => JSON.stringify([host.alias, host.ssh, host.accounts[account.name]?.home ?? null]);

/** Cache reads never contact hosts, and a missing or damaged cache is no data. */
export function cachedRemoteUsage(ctx: Ctx, account: AccountCfg, hosts?: Record<string, HostCfg>): UsageReading | null {
  try {
    const { reading, version, identity, sourceIdentity } = readJson<{ reading: UsageReading; version?: number; identity?: string; sourceIdentity?: string }>(cachePath(ctx, account.name)) ?? {};
    const host = reading?.remoteHost && hosts?.[reading.remoteHost];
    const sameSource = !hosts || !!host && sourceIdentity === origin(host, account);
    return reading && Number.isFinite(reading.capturedAt) && Array.isArray(reading.windows)
      && typeof reading.remoteHost === "string" ? version === 3 && sameSource && identity === accountEvidenceScope(account).identity
        ? reading : { ...reading, alternatives: undefined, capturedAt: null, stale: true } : null;
  } catch { return null; }
}

/** Passive Codex usage only; SSH or parse failures must never fail a task or host check. */
export async function probeCodexUsage(ctx: Ctx, host: HostCfg, account: AccountCfg): Promise<UsageReading | null> {
  if (account.kind !== "codex") return null;
  try {
    const grant = issueConfiguredRemoteUsage(ctx, host, account);
    const registry = pluginRegistry(ctx), caller = registry.find(ctx, "remoteCaller", () => true);
    if (caller !== "pacer-remote-caller") return null;
    const result = await registry.callWithIssuedHostUsage<ReturnType<typeof HOST_RUNNER_METHODS["hostRunner.run"]["result"]["parse"]>>(
      ctx, caller, "remoteCaller.usageRead",
      { alias: host.alias, ...(grant.resource.args[0] ? { home: grant.resource.args[0] } : {}) }, grant);
    if (result.code !== 0) return null;
    const observations = result.stdout.split("\n").slice(0, -1).flatMap(line => {
      try { const value = rateLimitObservation(JSON.parse(line)); return value ? [value] : []; } catch { return []; }
    }).filter(value => value.observedAt !== null && value.observedAt <= ctx.now)
      .sort((a, b) => b.observedAt! - a.observedAt!);
    if (!observations.length) return null;
    const reading: UsageReading = { ...readingFromObservation(observations[0]), remoteHost: host.alias,
      alternatives: observations.slice(1).map(readingFromObservation) };
    const cached = cachedRemoteUsage(ctx, account);
    const previous = cached?.remoteHost === host.alias ? cachedRemoteUsage(ctx, account, { [host.alias]: host }) : cached;
    if (!ctx.readOnly && (previous?.capturedAt == null || reading.capturedAt! > previous.capturedAt)) {
      writeJsonAtomic(cachePath(ctx, account.name), { version: 3, identity: accountEvidenceScope(account).identity,
        sourceIdentity: origin(host, account), reading, at: ctx.now });
    }
    return reading;
  } catch { return null; }
}
