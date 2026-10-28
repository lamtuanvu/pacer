import type { AccountCfg } from "../config/accounts";
import { defaultAccountFolder } from "../exec/account-folder";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson } from "../fsutil";
import type { Ctx, UsageReading } from "../types";
import { isObj, parseTs, toNum } from "../util";

/** Capture public quota telemetry emitted by Claude itself, never its credentials. */
export function captureClaudeStreamUsage(ctx: Ctx, account: AccountCfg, stdout: string): boolean {
  if (account.kind !== "claude") return false;
  const windows: Record<string, {used_percentage: number; resets_at: number | null}> = {};
  for (const line of stdout.split("\n")) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isObj(event) || event.type !== "rate_limit_event" || !isObj(event.rate_limit_info)) continue;
    const info = event.rate_limit_info;
    const unified = isObj(info.unifiedWindows) ? info.unifiedWindows : {};
    for (const name of ["seven_day", "five_hour"]) {
      const window = unified[name] ?? (info.rateLimitType === name ? info : undefined);
      if (!isObj(window)) continue;
      const used = window.utilization;
      if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 1) continue;
      windows[name] = {used_percentage: Math.round(used * 10000) / 100, resets_at: parseTs(window.resetsAt)};
    }
  }
  // Do not replace a complete account snapshot with incomplete telemetry or
  // make an older, missing window look fresh by borrowing this timestamp.
  if (!windows.seven_day || !windows.five_hour) return false;
  const path = claudeCacheFile(ctx, account), dir = dirname(path);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  chmodSync(dir, 0o700);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({...windows, captured_at: ctx.now, source: "session-log"}), {flag: "wx", mode: 0o600});
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return true;
}

/** Scan a completed stream without retaining the agent transcript in memory. */
export async function captureClaudeStreamUsageFile(ctx: Ctx, account: AccountCfg, path: string): Promise<boolean> {
  const decoder = new TextDecoder();
  let pending = "", oversized = false;
  let lastEvent = "";
  for await (const chunk of Bun.file(path).stream()) {
    pending += decoder.decode(chunk, {stream: true});
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!oversized && line.includes('"rate_limit_event"')) lastEvent = line;
      oversized = false;
    }
    if (pending.length > 1024 * 1024) { pending = ""; oversized = true; }
  }
  pending += decoder.decode();
  if (!oversized && pending.includes('"rate_limit_event"')) lastEvent = pending;
  return lastEvent ? captureClaudeStreamUsage(ctx, account, lastEvent) : false;
}

/** Claude's final result is the user-facing text in a structured run. */
export function claudeResultFromStream(stdout: string): string | null {
  for (const line of stdout.trimEnd().split("\n").reverse()) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (isObj(event) && event.type === "result" && typeof event.result === "string") return event.result;
  }
  return null;
}

export function claudeCacheFile(ctx: Ctx, account?: AccountCfg): string {
  return join(ctx.pacerHome, "cache", account && account.source !== "default"
    ? `claude-rate-limits.${encodeURIComponent(account.name)}.json` : "claude-rate-limits.json");
}

export function claudeCachePaths(ctx: Ctx, account?: AccountCfg): string[] {
  if (account && account.source !== "default") return [claudeCacheFile(ctx, account)];
  return [
    claudeCacheFile(ctx, account),
    join(defaultAccountFolder(ctx, "claude"), "state", "budget", "claude.json"),
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
    source: data.source === "session-log" ? "session-log" : "status-line",
    capturedAt,
    stale: false,
    windows: [
      { name: "weekly", usedPct: toNum(wk.used_percentage), resetsAt: parseTs(wk.resets_at), lengthS: 7 * 86400, paced: true },
      { name: "5h", usedPct: toNum(fh.used_percentage), resetsAt: parseTs(fh.resets_at), lengthS: 5 * 3600, paced: false },
    ],
  };
}
