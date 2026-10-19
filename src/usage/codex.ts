import type { Stats } from "node:fs";
import { CursorStore, reusable, type Cursor } from "./cursors";
import { statusTimer } from "./trace";
import type { AccountCfg } from "../config/accounts";
import { orcaAccountHome } from "../orca/accounts";
import { stat, open } from "node:fs/promises";
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

interface RateAggregate {
  found: Record<string, unknown> | null;
  position: number;
  last: Record<string, unknown> | null;
}
const codexStores = new Map<string, CursorStore<RateAggregate>>();

async function incrementalRateLimits(path: string, previous: Cursor<RateAggregate> | undefined): Promise<Cursor<RateAggregate>> {
  const file = await open(path, "r");
  try {
    const s = await file.stat();
    const cached = reusable(previous, s) ? previous : undefined;
    if (cached && cached.size === s.size) return cached;
    const tail = Math.max(0, s.size - TAIL_BYTES);
    const start = Math.max(tail, cached?.offset ?? tail);
    let found = cached && cached.aggregate.position >= tail ? cached.aggregate.found : null;
    let position = found ? cached!.aggregate.position : -1;
    const bytes = Buffer.alloc(s.size - start);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await file.read(bytes, read, bytes.length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    let offset = start;
    let lineStart = 0;
    let last = found;
    for (let i = 0; i <= read; i++) {
      if (i < read && bytes[i] !== 10) continue;
      const text = bytes.subarray(lineStart, i).toString("utf8");
      let candidate: Record<string, unknown> | null = null;
      if (text.includes('"rate_limits"')) {
        try { candidate = findRateLimits(JSON.parse(text)); } catch { /* Incomplete/corrupt line. */ }
      }
      if (i < read) {
        if (candidate) { found = candidate; position = start + lineStart; }
        offset = start + i + 1;
        last = found;
      } else last = candidate ?? found;
      lineStart = i + 1;
    }
    return { size: s.size, mtime: s.mtimeMs, inode: s.ino, offset,
      aggregate: { found, position, last } };
  } finally { await file.close(); }
}

export async function readCodex(ctx: Ctx, account?: AccountCfg): Promise<UsageReading> {
  const trace = statusTimer(ctx);
  const home = account?.source === "orca" ? orcaAccountHome(ctx, "codex", account.orcaAccount ?? "")
    : account?.home ? account.home.replace(/^~(?=\/|$)/, ctx.home) : join(ctx.home, ".codex");
  if (!home) return { windows: [], capturedAt: null, stale: false, error: "Orca account folder not found" };
  const root = join(home, "sessions");
  if (!existsSync(root)) return { windows: [], capturedAt: null, stale: false, error: "no Codex session logs" };
  const files: { p: string; m: number; info: Stats }[] = [];
  for await (const p of new Bun.Glob("**/rollout-*.jsonl").scan({ cwd: root, absolute: true })) {
    try {
      const info = await stat(p);
      files.push({ p, m: info.mtimeMs / 1000, info });
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  files.sort((a, b) => b.m - a.m);
  trace("codex.discovery");
  const key = join(ctx.pacerHome, "state", "codex-cursors.json");
  let store = codexStores.get(key);
  if (!store) {
    store = new CursorStore(key, value => isObj(value)
      && (value.found === null || isObj(value.found)) && (value.last === null || isObj(value.last))
      && typeof value.position === "number" && Number.isFinite(value.position));
    codexStores.set(key, store);
  }
  return store.run<UsageReading>(ctx, async cursors => {
    // Quota lookup has no mtime cutoff: preserve the newest-15 fallback even for old logs.
    const recent = files.slice(0, MAX_FILES);
    const live = new Set(recent.map(f => f.p));
    // Keep other account roots intact.
    for (const path of Object.keys(cursors)) if (path.startsWith(root + "/") && !live.has(path)) delete cursors[path];
    for (const f of recent) {
      let cursor: Cursor<RateAggregate>;
      try {
        const previous = cursors[f.p];
        cursor = reusable(previous, f.info) && previous.size === f.info.size
          ? previous : await incrementalRateLimits(f.p, previous);
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { delete cursors[f.p]; continue; }
        throw error;
      }
      cursors[f.p] = cursor;
      const rl = cursor.aggregate.last;
      if (!rl) continue;
      trace("codex.read-tail");
      return { windows: windowsFromRateLimits(rl, cursor.mtime / 1000), capturedAt: cursor.mtime / 1000, stale: false, source: "session-log" };
    }
    trace("codex.read-tail");
    return { windows: [], capturedAt: null, stale: false, error: "no rate_limits found in recent Codex session logs" };
  });
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
