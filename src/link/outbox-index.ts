import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import type { Ctx } from "../types";
import { parseOutboxEvent } from "./envelope";
import { outboxPath } from "./paths";
import type { OutboxEntry } from "./store";

export const isDiscoveryItemId = (id: unknown) => typeof id === "string" && (id.startsWith("discovery:") || id.startsWith("discovery-network:"));

export interface OutboxReplay {
  /** Entries with a seq above the requested one, in file order. */
  entries: OutboxEntry[];
  /** The first retained seq above 0. */
  oldest: number | undefined;
  /**
   * For each counts entity with a seq above 0, how many discovery attention items were open then; v2 counts leave them out.
   * The open set is rebuilt from the retained outbox only, so once the item's raise is trimmed away the v2 counts over-report
   * by that item until the client fetches the next snapshot (N10). That is acceptable for a legacy client.
   * Read it before the next replay of the same home.
   */
  discoveryOpen: ReadonlyMap<number, number>;
}

/**
 * Where each complete line of one outbox file starts, so a replay reads only the lines after the
 * client's cursor. `end` always follows a newline; a line still being written stays unindexed.
 */
interface OutboxIndex {
  dev: number;
  ino: number;
  mtimeMs: number;
  end: number;
  head: Buffer;
  last: Buffer;
  offsets: number[];
  /** Running maximum of seq, so the search is correct even if a writer appended out of order. */
  maxSeq: number[];
  oldest: number | undefined;
  open: Set<string>;
  openAt: Map<number, number>;
}

const MAX_INDEXED_FILES = 16;
const indexes = new Map<string, OutboxIndex>();

export function replayOutbox(ctx: Ctx, since: number): OutboxReplay {
  const path = outboxPath(ctx);
  let fd: number;
  try { fd = openSync(path, "r"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    indexes.delete(path);
    return { entries: [], oldest: undefined, discoveryOpen: new Map() };
  }
  try {
    const stat = fstatSync(fd);
    let index = indexes.get(path);
    if (!index || !unchangedBefore(fd, stat, index)) index = emptyIndex(stat);
    indexes.delete(path);
    indexes.set(path, index);
    if (indexes.size > MAX_INDEXED_FILES) indexes.delete(indexes.keys().next().value!);
    index.mtimeMs = stat.mtimeMs;

    const from = firstOffsetAfter(index, since);
    const bytes = readRange(fd, from, stat.size);
    const entries: OutboxEntry[] = [];
    let oldest = index.oldest, discoveryOpen: ReadonlyMap<number, number> = index.openAt;
    for (let start = 0; start < bytes.length;) {
      const newline = bytes.indexOf(10, start);
      const stop = newline < 0 ? bytes.length : newline + 1;
      const entry = parseLine(bytes.toString("utf8", start, newline < 0 ? stop : newline));
      if (newline >= 0 && from + start >= index.end) addLine(index, entry, from + start, bytes.subarray(start, stop));
      else if (newline < 0 && entry && entry.seq > 0) {
        // A complete record without its newline counts now but is indexed only once it ends.
        oldest ??= entry.seq;
        const env = entry.envelope;
        if (env.type === "entity" && env.data.kind === "counts") discoveryOpen = new Map(index.openAt).set(entry.seq, index.open.size);
      }
      if (entry && entry.seq > since) entries.push(entry);
      start = stop;
    }
    return { entries, oldest: index.oldest ?? oldest, discoveryOpen };
  } finally { closeSync(fd); }
}

function emptyIndex(stat: Stats): OutboxIndex {
  return {
    dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, end: 0, head: Buffer.alloc(0), last: Buffer.alloc(0),
    offsets: [], maxSeq: [], oldest: undefined, open: new Set(), openAt: new Map(),
  };
}

/** Rotation replaces the file and rewrites change its first or last indexed line; either rebuilds the index. */
function unchangedBefore(fd: number, stat: Stats, index: OutboxIndex): boolean {
  if (stat.dev !== index.dev || stat.ino !== index.ino || stat.size < index.end) return false;
  if (stat.size === index.end && stat.mtimeMs !== index.mtimeMs) return false;
  return readRange(fd, 0, index.head.length).equals(index.head) &&
    readRange(fd, index.end - index.last.length, index.end).equals(index.last);
}

function firstOffsetAfter(index: OutboxIndex, since: number): number {
  let low = 0, high = index.maxSeq.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (index.maxSeq[mid]! > since) high = mid; else low = mid + 1;
  }
  return low < index.offsets.length ? index.offsets[low]! : index.end;
}

function addLine(index: OutboxIndex, entry: OutboxEntry | null, offset: number, line: Buffer): void {
  if (index.end === 0) index.head = Buffer.from(line);
  index.last = Buffer.from(line);
  index.end = offset + line.length;
  if (!entry) return;
  index.offsets.push(offset);
  index.maxSeq.push(Math.max(entry.seq, index.maxSeq.at(-1) ?? -Infinity));
  if (entry.seq <= 0) return;
  index.oldest ??= entry.seq;
  const env = entry.envelope;
  if (env.type !== "entity") return;
  if (env.data.kind === "attention" && isDiscoveryItemId(env.data.id)) {
    if (env.data.removed) index.open.delete(env.data.id); else index.open.add(env.data.id);
  }
  if (env.data.kind === "counts") index.openAt.set(entry.seq, index.open.size);
}

function parseLine(line: string): OutboxEntry | null {
  if (!line) return null;
  try {
    const raw = JSON.parse(line) as { seq?: unknown; at?: unknown; envelope?: unknown };
    const envelope = parseOutboxEvent(raw.envelope);
    if (typeof raw.seq === "number" && envelope) return { seq: raw.seq, ...(typeof raw.at === "number" ? { at: raw.at } : {}), envelope };
  } catch { /* skip torn line */ }
  return null;
}

function readRange(fd: number, from: number, to: number): Buffer {
  const buffer = Buffer.allocUnsafe(Math.max(0, to - from));
  let filled = 0;
  while (filled < buffer.length) {
    const read = readSync(fd, buffer, filled, buffer.length - filled, from + filled);
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}
