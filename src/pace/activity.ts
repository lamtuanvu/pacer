import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

export const ACTIVITY_LOCK_STALE_S = 600;

export function tryActivityLock(ctx: Ctx): boolean {
  const path = join(ctx.pacerHome, "activity.lock");
  try {
    mkdirSync(ctx.pacerHome, { recursive: true });
    if (existsSync(path)) {
      const lock = readJson<{ at?: unknown }>(path);
      const at = typeof lock?.at === "number" && Number.isFinite(lock.at)
        ? lock.at : statSync(path).mtimeMs / 1000;
      if (ctx.now - at <= ACTIVITY_LOCK_STALE_S) return false;
      unlinkSync(path);
    }
    writeFileSync(path, JSON.stringify({ at: ctx.now, pid: process.pid }), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export function releaseActivityLock(ctx: Ctx): void {
  try {
    unlinkSync(join(ctx.pacerHome, "activity.lock"));
  } catch {
    // Lock cleanup is best effort, including when the file is already gone.
  }
}

export async function rebuildActivity(ctx: Ctx): Promise<ActivityProfile> {
  try {
    const fresh = await buildActivity(ctx);
    writeJsonAtomic(join(ctx.pacerHome, "activity.json"), fresh);
    return fresh;
  } finally {
    releaseActivityLock(ctx);
  }
}

export type RebuildTrigger = (ctx: Ctx) => void;

export const backgroundRebuild: RebuildTrigger = (ctx) => {
  const script = process.argv[1] ?? "";
  const cmd = /\.(ts|js|mjs)$/.test(script) ? [process.execPath, script] : [process.execPath];
  const isPacer = (cmd.length === 2 && /cli\.(ts|js)$/.test(cmd[1]))
    || (cmd.length === 1 && !/(^|\/)bun(\.exe)?$/.test(cmd[0]));
  if (!isPacer) {
    void rebuildActivity(ctx).catch(() => {});
    return;
  }
  try {
    const child = spawn(cmd[0], [...cmd.slice(1), "_activity"], {
      detached: true,
      stdio: "ignore",
      env: { ...ctx.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome },
    });
    child.on("error", () => releaseActivityLock(ctx));
    child.unref();
  } catch {
    releaseActivityLock(ctx);
  }
};

export async function loadActivity(
  ctx: Ctx, opts: { trigger?: RebuildTrigger } = {},
): Promise<ActivityProfile> {
  const path = join(ctx.pacerHome, "activity.json");
  const cached = readJson<ActivityProfile>(path);
  if (cached && cached.bins?.length === 168 && Array.isArray(cached.active)) {
    if (ctx.now - cached.builtAt < 86400) return cached;
    if (tryActivityLock(ctx)) {
      try {
        (opts.trigger ?? backgroundRebuild)(ctx);
      } catch {
        releaseActivityLock(ctx);
      }
    }
    return cached;
  }
  const fresh = await buildActivity(ctx);
  try {
    writeJsonAtomic(path, fresh);
  } catch {
    // A cache write failure must not discard the fresh profile.
  }
  return fresh;
}
