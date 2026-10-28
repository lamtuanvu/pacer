import { join } from "node:path";
import { defaultAccountFolder } from "../exec/account-folder";
import type { AccountCfg } from "../config/accounts";
import { orcaAccountHome } from "../orca/accounts";
import type { Ctx, UsageReading, UsageWindow } from "../types";
import { isObj } from "../util";

function accountHome(ctx: Ctx, account: AccountCfg): string | null {
  if (account.source === "orca") return orcaAccountHome(ctx, "codex", account.orcaAccount ?? "");
  return account.home ? account.home.replace(/^~(?=\/|$)/, ctx.home) : defaultAccountFolder(ctx, "codex");
}

function window(value: unknown): UsageWindow | null {
  if (!isObj(value) || typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)
    || value.usedPercent < 0 || value.usedPercent > 100) return null;
  const minutes = value.windowDurationMins;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  const resetsAt = typeof value.resetsAt === "number" && Number.isFinite(value.resetsAt) ? value.resetsAt : null;
  return { name: minutes >= 10080 ? "weekly" : `${Math.round(minutes / 60)}h`, usedPct: value.usedPercent,
    resetsAt, lengthS: minutes * 60, paced: minutes >= 1440 };
}

/** Ask Codex itself for current limits. No turn, transcript or native credential access. */
export async function readCodexLive(ctx: Ctx, account: AccountCfg): Promise<UsageReading> {
  const home = accountHome(ctx, account);
  if (!home) return { windows: [], capturedAt: null, stale: true, error: "Codex account home unavailable" };
  const request = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "pacer", version: "1" }, capabilities: {} } },
    { jsonrpc: "2.0", method: "initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  const result = await ctx.run(["codex", "-s", "read-only", "-a", "never", "app-server"], 15_000,
    { env: { ...ctx.env, CODEX_HOME: home }, stdin: request, stdinUntilResponseId: 2 });
  if (result.timedOut || result.code !== 0) return { windows: [], capturedAt: null, stale: true,
    error: result.timedOut ? "Codex usage request timed out" : "Codex usage request failed" };
  let response: Record<string, unknown> | null = null;
  for (const line of result.stdout.split("\n")) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObj(parsed) && parsed.id === 2) response = parsed;
    } catch { /* Ignore incomplete diagnostics or notifications. */ }
  }
  if (!response || isObj(response.error)) return { windows: [], capturedAt: null, stale: true, error: "Codex usage unavailable" };
  const payload = isObj(response.result) ? response.result : {};
  const limits = isObj(payload.rateLimits) ? payload.rateLimits : {};
  const windows = [window(limits.primary), window(limits.secondary)].filter((w): w is UsageWindow => w !== null);
  return windows.length ? { windows, capturedAt: ctx.now, stale: false, source: "provider-cli" }
    : { windows: [], capturedAt: null, stale: true, error: "Codex returned no quota windows" };
}
