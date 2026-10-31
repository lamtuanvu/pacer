import type { ReaderContext, UsageReading, UsageWindow, Cursor, FileInfo } from "./reader-types";
import { isObj, parseTs, toNum } from "./util";

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

export interface RateLimitObservation { rateLimits: Record<string, unknown>; observedAt: number | null; alternatives?: RateLimitObservation[] }
export function rateLimitObservation(event: unknown): RateLimitObservation | null {
  const rateLimits = findRateLimits(event);
  return rateLimits ? { rateLimits, observedAt: isObj(event) ? parseTs(event.timestamp) : null } : null;
}
function newer(a: RateLimitObservation | null, b: RateLimitObservation | null): RateLimitObservation | null {
  if (!a) return b;
  if (!b) return a;
  if (a.observedAt === b.observedAt) {
    const unique = [...new Map([a, ...(a.alternatives ?? []), b, ...(b.alternatives ?? [])]
      .map(({ alternatives: _, ...sample }) => [JSON.stringify(sample.rateLimits), sample])).values()];
    return { ...unique[unique.length - 1], alternatives: unique.slice(0, -1) };
  }
  return (b.observedAt ?? -Infinity) >= (a.observedAt ?? -Infinity) ? b : a;
}
export function readingFromObservation(observation: RateLimitObservation): UsageReading {
  const credits = observation.rateLimits.credits;
  return { windows: windowsFromRateLimits(observation.rateLimits, observation.observedAt), capturedAt: observation.observedAt,
    stale: false, source: "session-log",
    ...(observation.alternatives?.length ? { alternatives: observation.alternatives.map(readingFromObservation) } : {}),
    ...(isObj(credits) ? { spending: { creditsAvailable: typeof credits.has_credits === "boolean" ? credits.has_credits : null,
      creditBalance: toNum(typeof credits.balance === "string" && credits.balance.trim() ? Number(credits.balance) : credits.balance), paidConsumption: "unknown" as const } } : {}),
  };
}
interface RateAggregate {
  found: RateLimitObservation | null;
  position: number;
  last: RateLimitObservation | null;
}
function reusable<T>(cursor: Cursor<T> | undefined, info: FileInfo): cursor is Cursor<T> {
  return !!cursor && Number.isFinite(cursor.offset) && cursor.offset >= 0 && cursor.offset <= cursor.size
    && Number.isFinite(cursor.size) && Number.isFinite(cursor.mtime) && cursor.inode === info.inode && cursor.size <= info.size
    && (cursor.size !== info.size || cursor.mtime === info.mtimeMs);
}

async function incrementalRateLimits(ctx: ReaderContext, path: string, previous: Cursor<RateAggregate> | undefined, now = Infinity): Promise<Cursor<RateAggregate>> {
  const s = await ctx.io.stat(path);
  if (!s) throw Object.assign(new Error("Codex log disappeared"), { code: "ENOENT" });
  const cached = reusable(previous, s) ? previous : undefined;
  if (cached && cached.size === s.size) return cached;
  const tail = Math.max(0, s.size - TAIL_BYTES);
  const start = Math.max(tail, cached?.offset ?? tail);
  let found = cached && cached.aggregate.position >= tail ? cached.aggregate.found : null;
  let position = found ? cached!.aggregate.position : -1;
  const bytes = new Uint8Array(s.size - start);
  let read = 0;
  while (read < bytes.length) {
    const chunk = await ctx.io.range(path, start + read, Math.min(256 * 1024, bytes.length - read), s);
    if (!chunk.bytes.length) break;
    bytes.set(chunk.bytes, read);
    read += chunk.bytes.length;
  }
  let offset = start;
  let lineStart = 0;
  let last = found;
  for (let i = 0; i <= read; i++) {
    if (i < read && bytes[i] !== 10) continue;
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(lineStart, i));
    let candidate: RateLimitObservation | null = null;
    if (text.includes('"rate_limits"')) {
      try { candidate = rateLimitObservation(JSON.parse(text)); } catch { /* Incomplete/corrupt line. */ }
    }
    if (candidate?.observedAt !== null && candidate?.observedAt !== undefined && candidate.observedAt > now) candidate = null;
    if (i < read) {
      if (candidate) {
        const merged = newer(found, candidate);
        if (merged !== found) { found = merged; position = start + lineStart; }
      }
      offset = start + i + 1;
      last = found;
    } // An unterminated JSONL record is provisional, never permission-bearing.
    lineStart = i + 1;
  }
  return { size: s.size, mtime: s.mtimeMs, inode: s.inode, offset,
    aggregate: { found, position, last } };
}

export async function readCodex(ctx: ReaderContext): Promise<UsageReading> {
  const root = ctx.resources?.codexSessions;
  if (!root || !await ctx.io.stat(root)) return { windows: [], capturedAt: null, stale: false, error: "no Codex session logs" };
  const files = (await ctx.io.list(root, "**/rollout-*.jsonl")).map(info => ({ p: info.path, m: info.mtimeMs / 1000, info }));
  files.sort((a, b) => b.m - a.m);
  return ctx.io.cursors<RateAggregate, UsageReading>("codex-cursors", 4, value => isObj(value)
    && (value.found === null || isObj(value.found)) && (value.last === null || isObj(value.last))
    && typeof value.position === "number" && Number.isFinite(value.position), async cursors => {
    // Quota lookup has no mtime cutoff: preserve the newest-15 fallback even for old logs.
    const recent = files.slice(0, MAX_FILES);
    const live = new Set(recent.map(f => f.p));
    // Keep other account roots intact.
    for (const path of Object.keys(cursors)) if (path.startsWith(root + "/") && !live.has(path)) delete cursors[path];
    let selected: RateLimitObservation | null = null;
    const samples: RateLimitObservation[] = [];
    for (const f of recent) {
      let cursor: Cursor<RateAggregate>;
      try {
        const previous = cursors[f.p];
        cursor = reusable(previous, f.info) && previous.size === f.info.size
          ? previous : await incrementalRateLimits(ctx, f.p, previous, ctx.now);
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { delete cursors[f.p]; continue; }
        throw error;
      }
      cursors[f.p] = cursor;
      const observation = cursor.aggregate.last;
      if (observation?.observedAt != null && observation.observedAt > ctx.now) continue;
      if (observation) samples.push(observation);
      selected = newer(selected, observation);
    }
    if (selected) {
      const reading = readingFromObservation(selected);
      return { ...reading, alternatives: [...(reading.alternatives ?? []),
        ...samples.filter(sample => sample.observedAt !== selected!.observedAt).map(readingFromObservation)] };
    }
    return { windows: [], capturedAt: null, stale: false, error: "no rate_limits found in recent Codex session logs" };
  });
}

/** Shared conversion for local rollout files and the SSH session-log probe. */
export function windowsFromRateLimits(rl: Record<string, unknown>, observedAt: number | null): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = rl[key];
    if (!isObj(w)) continue;
    const mins = toNum(w.window_minutes) ?? 10080;
    let resetsAt = parseTs(w.resets_at);
    const inS = toNum(w.resets_in_seconds);
    if (resetsAt === null && inS !== null && observedAt !== null) resetsAt = observedAt + inS;
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
