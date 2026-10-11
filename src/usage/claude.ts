import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "../fsutil";
import type { Ctx, UsageReading } from "../types";
import { isObj, parseTs, toNum } from "../util";

export function claudeCachePaths(ctx: Ctx): string[] {
  return [
    join(ctx.pacerHome, "cache", "claude-rate-limits.json"),
    join(ctx.home, ".claude", "state", "budget", "claude.json"),
  ];
}

export async function readClaude(ctx: Ctx): Promise<UsageReading> {
  const files = claudeCachePaths(ctx)
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const data = files.length ? readJson<Record<string, unknown>>(files[0]) : null;
  if (!isObj(data)) {
    return { windows: [], capturedAt: null, stale: false, error: "no Claude rate-limit data yet (the Claude Code status line writes it)" };
  }
  const wk = isObj(data.seven_day) ? data.seven_day : {};
  const fh = isObj(data.five_hour) ? data.five_hour : {};
  const capturedAt = parseTs(data.captured_at);
  return {
    capturedAt,
    stale: capturedAt !== null && ctx.now - capturedAt > 86400,
    windows: [
      { name: "weekly", usedPct: toNum(wk.used_percentage), resetsAt: parseTs(wk.resets_at), lengthS: 7 * 86400, paced: true },
      { name: "5h", usedPct: toNum(fh.used_percentage), resetsAt: parseTs(fh.resets_at), lengthS: 5 * 3600, paced: false },
    ],
  };
}
