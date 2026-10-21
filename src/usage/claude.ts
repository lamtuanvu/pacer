import type { AccountCfg } from "../config/accounts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "../fsutil";
import type { Ctx, UsageReading } from "../types";
import { isObj, parseTs, toNum } from "../util";

export function claudeCacheFile(ctx: Ctx, account?: AccountCfg): string {
  return join(ctx.pacerHome, "cache", account && account.source !== "default"
    ? `claude-rate-limits.${encodeURIComponent(account.name)}.json` : "claude-rate-limits.json");
}

export function claudeCachePaths(ctx: Ctx, account?: AccountCfg): string[] {
  if (account && account.source !== "default") return [claudeCacheFile(ctx, account)];
  return [
    claudeCacheFile(ctx, account),
    join(ctx.home, ".claude", "state", "budget", "claude.json"),
  ];
}

export async function readClaude(ctx: Ctx, account?: AccountCfg): Promise<UsageReading> {
  const candidates = claudeCachePaths(ctx, account).filter(p => existsSync(p))
    .map(p => readJson<Record<string, unknown>>(p)).filter(isObj);
  const data = candidates.filter(d => { const at = parseTs(d.captured_at); return at === null || at <= ctx.now; })
    .sort((a, b) => (parseTs(b.captured_at) ?? -Infinity) - (parseTs(a.captured_at) ?? -Infinity))[0];
  if (!isObj(data)) {
    return { windows: [], capturedAt: null, stale: false, error: "no Claude rate-limit data yet (the Claude Code status line writes it)" };
  }
  const wk = isObj(data.seven_day) ? data.seven_day : {};
  const fh = isObj(data.five_hour) ? data.five_hour : {};
  const capturedAt = parseTs(data.captured_at);
  return {
    source: "status-line",
    capturedAt,
    stale: false,
    windows: [
      { name: "weekly", usedPct: toNum(wk.used_percentage), resetsAt: parseTs(wk.resets_at), lengthS: 7 * 86400, paced: true },
      { name: "5h", usedPct: toNum(fh.used_percentage), resetsAt: parseTs(fh.resets_at), lengthS: 5 * 3600, paced: false },
    ],
  };
}
