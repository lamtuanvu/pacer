import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { CursorStore, reusable, type Cursor } from "../usage/cursors";
import { statusTimer } from "../usage/trace";
import { randomUUID } from "node:crypto";
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

const TS_MARKER = Buffer.from('"timestamp":"');

export function hourBin(ts: number): number {
  const d = new Date(ts * 1000);
  return d.getDay() * 24 + d.getHours();
}

type LogFile = { path: string; info: Stats };

async function logFiles(ctx: Ctx, since: number): Promise<LogFile[]> {
  const roots: [string, string][] = [
    [join(ctx.home, ".claude"), "projects/*/*.jsonl"],
    [join(ctx.home, ".codex", "sessions"), "**/rollout-*.jsonl"],
  ];
  const out: LogFile[] = [];
  for (const [cwd, pattern] of roots) {
    if (!existsSync(cwd)) continue;
    for await (const p of new Bun.Glob(pattern).scan({ cwd, absolute: true })) {
      try {
        const info = await stat(p);
        if (info.mtimeMs / 1000 >= since) out.push({ path: p, info });
      } catch {
        // Skip logs that vanished or cannot be inspected.
      }
    }
  }
  return out;
}

type ActivityHours = Record<string, [number, number]>;
const activityStores = new Map<string, CursorStore<ActivityHours>>();
const LOOKBACK_S = 28 * 86400;

function validHours(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([hour, range]) => Number.isInteger(Number(hour))
      && Array.isArray(range) && range.length === 2 && range.every(Number.isFinite)
      && range[0] <= range[1] && range.every(ts => Math.floor(ts / 3600) === Number(hour)));
}

/** Each hour needs only its first and last timestamp for windows spanning hours.
 * For a window contained in one hour, test actual timestamps during a full scan:
 * neither min/max nor distinct minute buckets can resolve arbitrary gaps exactly.
 */
async function activityStamps(
  path: string, previous: Cursor<ActivityHours> | undefined,
  exactWindow?: { since: number; now: number; hours: Set<number> },
): Promise<Cursor<ActivityHours>> {
  const file = await open(path, "r");
  try {
    const s = await file.stat();
    const cached = reusable(previous, s) ? previous : undefined;
    if (cached && cached.size === s.size) return cached;
    const hours: ActivityHours = { ...cached?.aggregate };
    let offset = cached?.offset ?? 0;
    const buffer = Buffer.alloc(256 * 1024);
    // Retain an unfinished marker/value so arbitrary read and append boundaries
    // (including UTF-8 and long timestamp strings) match the full-text regex.
    let carry = Buffer.alloc(0);
    while (offset < s.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, s.size - offset), offset);
      if (!bytesRead) break;
      const bytes = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      let next = 0, keep = Math.max(0, bytes.length - TS_MARKER.length + 1);
      for (;;) {
        const start = bytes.indexOf(TS_MARKER, next);
        if (start < 0) break;
        const end = bytes.indexOf(34, start + TS_MARKER.length);
        if (end < 0) { keep = start; break; }
        const ts = parseTs(bytes.subarray(start + TS_MARKER.length, end).toString("utf8"));
        if (ts !== null) {
          const hour = Math.floor(ts / 3600);
          const range = hours[hour];
          hours[hour] = range ? [Math.min(range[0], ts), Math.max(range[1], ts)] : [ts, ts];
          if (exactWindow && ts >= exactWindow.since && ts <= exactWindow.now) exactWindow.hours.add(hour);
        }
        next = end + 1;
      }
      carry = Buffer.from(bytes.subarray(keep));
      offset += bytesRead;
    }
    return { size: s.size, mtime: s.mtimeMs, inode: s.ino,
      offset: offset - carry.length, aggregate: hours };
  } finally { await file.close(); }
}

export async function buildActivity(
  ctx: Ctx, opts: { lookbackDays?: number; threshold?: number } = {},
): Promise<ActivityProfile> {
  const trace = statusTimer(ctx);
  const since = ctx.now - (opts.lookbackDays ?? 28) * 86400;
  const threshold = opts.threshold ?? 0.2;
  const key = join(ctx.pacerHome, "state", "activity-cursors.json");
  let store = activityStores.get(key);
  if (!store) {
    store = new CursorStore(key, validHours, 2);
    activityStores.set(key, store);
  }
  return store.run(ctx, async cursors => {
    const files = await logFiles(ctx, since);
    trace("activity.discovery");
    const live = new Set(files.map(f => f.path));
    for (const path of Object.keys(cursors)) if (!live.has(path)) delete cursors[path];
    const hours = new Set<number>();
    let skipped = 0, bytes = 0;
    for (const { path, info } of files) {
      try {
        const previous = cursors[path];
        const sameHour = Math.floor(since / 3600) === Math.floor(ctx.now / 3600);
        // A longer lookback or a clock moving backwards may require pruned hours.
        const usable = !sameHour && (previous?.retainedSince === undefined || since >= previous.retainedSince)
          ? previous : undefined;
        let cursor = reusable(usable, info) && usable.size === info.size
          ? usable : await activityStamps(path, usable, sameHour ? { since, now: ctx.now, hours } : undefined);
        if (cursor === previous) skipped++;
        else bytes += cursor.size - (reusable(usable, info) ? usable.offset : 0);
        if (!sameHour) {
          for (const [hour, [minTs, maxTs]] of Object.entries(cursor.aggregate)) {
            if (maxTs >= since && minTs <= ctx.now) hours.add(Number(hour));
          }
        }
        const retainedSince = Math.floor((ctx.now - LOOKBACK_S) / 3600) * 3600;
        const retained = Object.entries(cursor.aggregate).filter(([hour]) => Number(hour) * 3600 >= retainedSince);
        if (retained.length !== Object.keys(cursor.aggregate).length || cursor.retainedSince === undefined) {
          cursor = { ...cursor, retainedSince, aggregate: Object.fromEntries(retained) };
        }
        cursors[path] = cursor;
      } catch {
        delete cursors[path]; // Match full scan: unreadable or vanished logs contribute nothing.
      }
    }
    trace(`activity.read-and-aggregate files=${files.length} unchanged=${skipped} bytes=${bytes}`);
    const bins = new Array<number>(168).fill(0);
    const dates = new Set<string>();
    for (const h of hours) {
      const ts = h * 3600;
      bins[hourBin(ts)] += 1;
      dates.add(new Date(ts * 1000).toDateString());
    }
    const max = Math.max(0, ...bins);
    return { builtAt: ctx.now, days: dates.size, bins, active: bins.map(b => max > 0 && b >= threshold * max) };
  });
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
    writeFileSync(path, JSON.stringify({ at: ctx.now, pid: process.pid, token: randomUUID() }), { flag: "wx" });
    return readJson<{ pid?: unknown }>(path)?.pid === process.pid;
  } catch {
    return false;
  }
}

export function releaseActivityLock(ctx: Ctx): void {
  try {
    const path = join(ctx.pacerHome, "activity.lock");
    const lock = readJson<{ pid?: unknown; token?: unknown }>(path);
    const token = ctx.env.PACER_ACTIVITY_LOCK_TOKEN;
    if (token ? lock?.token === token : lock?.pid === process.pid) unlinkSync(path);
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
    const lock = readJson<{ pid?: unknown; token?: string }>(join(ctx.pacerHome, "activity.lock"));
    if (lock?.pid !== process.pid || !lock.token) return;
    const child = spawn(cmd[0], [...cmd.slice(1), "_activity"], {
      detached: true,
      stdio: "ignore",
      env: { ...ctx.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome, PACER_ACTIVITY_LOCK_TOKEN: lock.token },
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
    if (!ctx.readOnly && tryActivityLock(ctx)) {
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
    if (!ctx.readOnly) writeJsonAtomic(path, fresh);
  } catch {
    // A cache write failure must not discard the fresh profile.
  }
  return fresh;
}
