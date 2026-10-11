import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { parseTs } from "../util";

export interface ActivityProfile {
  builtAt: number;
  days: number;       // distinct local dates with activity
  bins: number[];     // 168 counts of active clock-hours, index weekday*24+hour
  active: boolean[];  // bins[i] >= threshold * max(bins)
}

const TS_RE = /"timestamp":"([^"]+)"/g;

export function hourBin(ts: number): number {
  const d = new Date(ts * 1000);
  return d.getDay() * 24 + d.getHours();
}

async function logFiles(ctx: Ctx, since: number): Promise<string[]> {
  const roots: [string, string][] = [
    [join(ctx.home, ".claude"), "projects/*/*.jsonl"],
    [join(ctx.home, ".codex", "sessions"), "**/rollout-*.jsonl"],
  ];
  const out: string[] = [];
  for (const [cwd, pattern] of roots) {
    if (!existsSync(cwd)) continue;
    for await (const p of new Bun.Glob(pattern).scan({ cwd, absolute: true })) {
      try {
        if (statSync(p).mtimeMs / 1000 >= since) out.push(p);
      } catch {
        // Skip logs that vanished or cannot be inspected.
      }
    }
  }
  return out;
}

export async function buildActivity(
  ctx: Ctx, opts: { lookbackDays?: number; threshold?: number } = {},
): Promise<ActivityProfile> {
  const lookback = (opts.lookbackDays ?? 28) * 86400;
  const threshold = opts.threshold ?? 0.2;
  const since = ctx.now - lookback;
  const hours = new Set<number>();
  for (const f of await logFiles(ctx, since)) {
    let text: string;
    try {
      text = await Bun.file(f).text();
    } catch {
      continue;
    }
    for (const m of text.matchAll(TS_RE)) {
      const ts = parseTs(m[1]);
      if (ts !== null && ts >= since && ts <= ctx.now) hours.add(Math.floor(ts / 3600));
    }
  }
  const bins = new Array<number>(168).fill(0);
  const dates = new Set<string>();
  for (const h of hours) {
    const ts = h * 3600;
    bins[hourBin(ts)] += 1;
    dates.add(new Date(ts * 1000).toDateString());
  }
  const max = Math.max(0, ...bins);
  return { builtAt: ctx.now, days: dates.size, bins, active: bins.map((b) => max > 0 && b >= threshold * max) };
}

export async function loadActivity(ctx: Ctx): Promise<ActivityProfile> {
  const path = join(ctx.pacerHome, "activity.json");
  const cached = readJson<ActivityProfile>(path);
  if (cached && ctx.now - cached.builtAt < 86400 && cached.bins?.length === 168) return cached;
  const fresh = await buildActivity(ctx);
  try {
    writeJsonAtomic(path, fresh);
  } catch {
    // A cache write failure must not discard the fresh profile.
  }
  return fresh;
}
