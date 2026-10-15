import type { AccountCfg } from "../config/accounts";
import { orcaAccountHome } from "../orca/accounts";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, UsageReading, UsageWindow } from "../types";
import { isObj, parseTs, toNum } from "../util";

const TAIL_BYTES = 4_000_000;
const MAX_FILES = 15;

export function findRateLimits(root: unknown): Record<string, unknown> | null {
  const stack: unknown[] = [root];
  while (stack.length) {
    const o = stack.pop();
    if (Array.isArray(o)) stack.push(...o);
    else if (isObj(o)) {
      if (isObj(o.rate_limits) && o.rate_limits.primary != null) return o.rate_limits;
      stack.push(...Object.values(o));
    }
  }
  return null;
}

/** The last rate_limits object with a primary window in a rollout file (reads only the tail). */
export async function lastRateLimits(path: string): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path);
  const text = await file.slice(Math.max(0, file.size - TAIL_BYTES)).text();
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const found = findRateLimits(obj);
    if (found) return found;
  }
  return null;
}

export async function readCodex(ctx: Ctx, account?: AccountCfg): Promise<UsageReading> {
  const home = account?.source === "orca" ? orcaAccountHome(ctx, "codex", account.orcaAccount ?? "")
    : account?.home ? account.home.replace(/^~(?=\/|$)/, ctx.home) : join(ctx.home, ".codex");
  if (!home) return { windows: [], capturedAt: null, stale: false, error: "Orca account folder not found" };
  const root = join(home, "sessions");
  if (!existsSync(root)) return { windows: [], capturedAt: null, stale: false, error: "no Codex session logs" };
  const files: { p: string; m: number }[] = [];
  for await (const p of new Bun.Glob("**/rollout-*.jsonl").scan({ cwd: root, absolute: true })) {
    files.push({ p, m: (await stat(p)).mtimeMs / 1000 });
  }
  files.sort((a, b) => b.m - a.m);
  for (const f of files.slice(0, MAX_FILES)) {
    const rl = await lastRateLimits(f.p);
    if (!rl) continue;
    const windows = windowsFromRateLimits(rl, f.m);
    return { windows, capturedAt: f.m, stale: false, source: "session-log" };
  }
  return { windows: [], capturedAt: null, stale: false, error: "no rate_limits found in recent Codex session logs" };
}

/** Shared conversion for local rollout files and the SSH session-log probe. */
export function windowsFromRateLimits(rl: Record<string, unknown>, mtime: number): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = rl[key];
    if (!isObj(w)) continue;
    const mins = toNum(w.window_minutes) ?? 10080;
    let resetsAt = parseTs(w.resets_at);
    const inS = toNum(w.resets_in_seconds);
    if (resetsAt === null && inS !== null) resetsAt = mtime + inS;
    windows.push({
      name: mins >= 7 * 1440 ? "weekly" : `${Math.round(mins / 60)}h`,
      usedPct: toNum(w.used_percent),
      resetsAt,
      lengthS: mins * 60,
      paced: mins >= 1440,
    });
  }
  return windows;
}
