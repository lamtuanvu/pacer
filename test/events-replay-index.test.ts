import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { eventsSince } from "../src/api/events";
import { V3_CURSOR_BASE } from "../src/api/v2-compat";
import type { OutboxEvent } from "../src/link/envelope";
import { linkDir, outboxPath } from "../src/link/paths";
import { outboxIndexStats, replayOutbox } from "../src/link/outbox-index";
import { appendOutbox, OUTBOX_KEEP, OUTBOX_MAX_BYTES, OUTBOX_ROTATE_LINES, readOutboxSince } from "../src/link/store";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

const alert = (seq: number, body = ""): { seq: number; at: number; envelope: OutboxEvent } =>
  ({ seq, at: 1, envelope: { type: "alert", data: { key: `alert-${seq}`, level: "info", title: `Alert ${seq}`, body, at: 1 } } });
const attention = (id: string, removed = false): OutboxEvent =>
  ({ type: "entity", data: removed ? { kind: "attention", id, removed: true } : { kind: "attention", id, value: { id } } });
const counts = (n: number): OutboxEvent =>
  ({ type: "entity", data: { kind: "counts", id: "counts", value: { attention: n, problems: 0, review: 0 } } });
const line = (seq: number, envelope: OutboxEvent) => `${JSON.stringify({ seq, at: 1, envelope })}\n`;

/** The same outbox bytes in a home this process has never indexed: today's full rescan. */
function rescan(ctx: Ctx): Ctx {
  const fresh = fakeCtx({ now: ctx.now });
  mkdirSync(linkDir(fresh), { recursive: true, mode: 0o700 });
  writeFileSync(outboxPath(fresh), readFileSync(outboxPath(ctx)), { mode: 0o600 });
  return fresh;
}

function expectSameReplay(ctx: Ctx, cursors: number[]) {
  const reference = rescan(ctx);
  for (const since of cursors) for (const protocol of [2, 3] as const) {
    const cursor = protocol === 3 && since > 0 ? V3_CURSOR_BASE + since : since;
    expect(JSON.stringify(eventsSince(ctx, cursor, protocol))).toBe(JSON.stringify(eventsSince(reference, cursor, protocol)));
  }
  expect(readOutboxSince(ctx, 0)).toEqual(readOutboxSince(reference, 0));
}

function bytesRead(run: () => void): number {
  const reads = spyOn(fs, "readSync"), whole = spyOn(fs, "readFileSync");
  try {
    run();
    expect(whole.mock.calls.filter(([path]) => String(path).endsWith("outbox.jsonl"))).toEqual([]);
    return reads.mock.results.reduce((sum, r) => sum + (r.type === "return" ? Number(r.value) : 0), 0);
  } finally { reads.mockRestore(); whole.mockRestore(); }
}

test("replay reads only lines after the cursor", () => {
  const ctx = fakeCtx(), padding = "x".repeat(400);
  appendOutbox(ctx, Array.from({ length: OUTBOX_KEEP }, (_, i) => alert(i + 1, padding)));
  const size = statSync(outboxPath(ctx)).size, lineSize = size / OUTBOX_KEEP;
  expect(eventsSince(ctx, 0, 3).events).toHaveLength(OUTBOX_KEEP);

  const caughtUp = bytesRead(() => expect(eventsSince(ctx, V3_CURSOR_BASE + OUTBOX_KEEP, 3).events).toEqual([]));
  expect(caughtUp).toBeLessThan(4 * lineSize);

  const tail = bytesRead(() => expect(eventsSince(ctx, OUTBOX_KEEP - 10, 2).events.map(e => e.seq)).toEqual(Array.from({ length: 10 }, (_, i) => OUTBOX_KEEP - 9 + i)));
  expect(tail).toBeLessThan(14 * lineSize);

  appendFileSync(outboxPath(ctx), line(OUTBOX_KEEP + 1, alert(0).envelope));
  const appended = bytesRead(() => expect(eventsSince(ctx, V3_CURSOR_BASE + OUTBOX_KEEP, 3).events.map(e => e.seq)).toEqual([V3_CURSOR_BASE + OUTBOX_KEEP + 1]));
  expect(appended).toBeLessThan(4 * lineSize);
  expect(appended).toBeLessThan(size / 50);
  expectSameReplay(ctx, [0, 500, OUTBOX_KEEP, OUTBOX_KEEP + 1]);
});

test("rotation rebuilds the index", () => {
  const ctx = fakeCtx();
  appendOutbox(ctx, Array.from({ length: OUTBOX_KEEP }, (_, i) => alert(i + 1)));
  expect(eventsSince(ctx, 0, 2).events).toHaveLength(OUTBOX_KEEP);
  // This process rotates: the oldest lines go and the file is replaced.
  appendOutbox(ctx, Array.from({ length: 300 }, (_, i) => alert(OUTBOX_KEEP + i + 1)));
  expect(readOutboxSince(ctx, 0)[0]?.seq).toBe(301);
  expectSameReplay(ctx, [0, 200, 300, 900, 1300]);

  // Another process rotates by renaming a new file over the outbox.
  const tmp = `${outboxPath(ctx)}.other.tmp`;
  writeFileSync(tmp, Array.from({ length: 50 }, (_, i) => line(2000 + i, alert(0).envelope)).join(""), { mode: 0o600 });
  renameSync(tmp, outboxPath(ctx));
  expect(readOutboxSince(ctx, 0).map(e => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 2000 + i));
  expectSameReplay(ctx, [0, 1300, 2010, 2049]);

  // A rewrite in place keeps the inode: shorter, then longer than what was indexed.
  writeFileSync(outboxPath(ctx), line(3000, alert(0).envelope));
  expect(readOutboxSince(ctx, 0).map(e => e.seq)).toEqual([3000]);
  writeFileSync(outboxPath(ctx), Array.from({ length: 80 }, (_, i) => line(4000 + i, alert(0).envelope)).join(""));
  expect(readOutboxSince(ctx, 3990).map(e => e.seq)).toEqual(Array.from({ length: 80 }, (_, i) => 4000 + i));
  expectSameReplay(ctx, [0, 3000, 4040]);
});

test("fifty appends past the limit rebuild the index at most once", () => {
  const ctx = fakeCtx(), start = OUTBOX_ROTATE_LINES - 25;
  appendOutbox(ctx, Array.from({ length: start }, (_, i) => alert(i + 1)));
  expect(readOutboxSince(ctx, 0)).toHaveLength(start);
  const before = outboxIndexStats.rebuilds;
  for (let seq = start + 1; seq <= start + 50; seq++) {
    appendOutbox(ctx, [alert(seq)]);
    expect(eventsSince(ctx, seq - 1, 2).events.map(e => e.seq)).toEqual([seq]);
  }
  expect(outboxIndexStats.rebuilds - before).toBeLessThanOrEqual(1);
  expect(readOutboxSince(ctx, 0).length).toBeLessThanOrEqual(OUTBOX_ROTATE_LINES);
  expectSameReplay(ctx, [0, start, start + 50]);
});

test("rotation trims back to both retention limits", () => {
  const ctx = fakeCtx();
  appendOutbox(ctx, Array.from({ length: OUTBOX_ROTATE_LINES + 1 }, (_, i) => alert(i + 1)));
  expect(readOutboxSince(ctx, 0).map(e => e.seq)).toEqual(Array.from({ length: OUTBOX_KEEP }, (_, i) => OUTBOX_ROTATE_LINES + 2 - OUTBOX_KEEP + i));

  const large = fakeCtx(), padding = "x".repeat(2000);
  appendOutbox(large, Array.from({ length: 700 }, (_, i) => alert(i + 1, padding)));
  const lines = readFileSync(outboxPath(large), "utf8").trimEnd().split("\n");
  expect(lines.length).toBeLessThan(700);
  expect(statSync(outboxPath(large)).size).toBeLessThanOrEqual(OUTBOX_MAX_BYTES);
  expect(JSON.parse(lines.at(-1)!).seq).toBe(700);
});

test("discovery aggregates match a full rescan after appends and rotation", () => {
  const ctx = fakeCtx();
  let seq = 0;
  const add = (...events: OutboxEvent[]) => appendOutbox(ctx, events.map(envelope => ({ seq: ++seq, at: ctx.now, envelope })));
  add(attention("discovery:peer-a"), attention("discovery-network:k1"), attention("failed:t-1"), counts(3));
  const v2Counts = (since: number) => eventsSince(ctx, since, 2).events.filter(e => e.type === "counts").map(e => (e.data as { attention: number }).attention);
  expect(v2Counts(0)).toEqual([1]);
  add(attention("discovery-network:k1", true), counts(2));
  add(attention("discovery:peer-b"), counts(3));
  expect(v2Counts(0)).toEqual([1, 1, 1]);
  expect(v2Counts(seq - 1)).toEqual([1]);
  expectSameReplay(ctx, [0, 3, 5, seq]);

  // Rotation trims the raise of peer-a, so the rebuilt open set forgets it.
  for (let i = 0; i < OUTBOX_ROTATE_LINES / 2; i++) add(alert(0).envelope, alert(0).envelope);
  add(attention("discovery:peer-c"), counts(4));
  expect(readOutboxSince(ctx, 0)[0]?.seq).toBeGreaterThan(8);
  expect(v2Counts(seq - 2)).toEqual([3]);
  expectSameReplay(ctx, [0, seq - 2, seq]);
});

test("a replay's discovery counts stay fixed after later replays", () => {
  const ctx = fakeCtx();
  appendOutbox(ctx, [{ seq: 1, at: 1, envelope: attention("discovery:peer-a") }, { seq: 2, at: 1, envelope: counts(1) }]);
  const first = replayOutbox(ctx, 0).discoveryOpen;
  expect([...first]).toEqual([[2, 1]]);
  appendOutbox(ctx, [{ seq: 3, at: 1, envelope: counts(1) }]);
  expect([...replayOutbox(ctx, 0).discoveryOpen]).toEqual([[2, 1], [3, 1]]);
  expect([...first]).toEqual([[2, 1]]);
});

test("reset behaviour unchanged for a too-old cursor", () => {
  const ctx = fakeCtx();
  appendOutbox(ctx, Array.from({ length: OUTBOX_KEEP }, (_, i) => alert(i + 1)));
  const cursor = 600;
  expect(eventsSince(ctx, cursor, 2)).toMatchObject({ reset: false, last: OUTBOX_KEEP });
  // The client holds its cursor while the outbox rotates past it.
  appendOutbox(ctx, Array.from({ length: 700 }, (_, i) => alert(OUTBOX_KEEP + i + 1)));
  const oldest = readOutboxSince(ctx, 0)[0]!.seq;
  expect(oldest).toBe(701);
  const v2 = eventsSince(ctx, cursor, 2);
  expect(v2.reset).toBe(true);
  expect(v2.events[0]).toMatchObject({ type: "reset", seq: oldest - 1 });
  expect(v2.events.slice(1).map(e => e.seq)).toEqual(Array.from({ length: OUTBOX_KEEP }, (_, i) => oldest + i));
  const v3 = eventsSince(ctx, V3_CURSOR_BASE + cursor, 3);
  expect(v3).toMatchObject({ reset: true, last: V3_CURSOR_BASE + 1700 });
  expect(v3.events[0]).toMatchObject({ type: "reset", seq: V3_CURSOR_BASE + oldest - 1 });
  expect(eventsSince(ctx, oldest - 1, 2).reset).toBe(false);
  const protocolReset = eventsSince(ctx, 1, 3);
  expect(protocolReset.reset).toBe(true);
  expect(protocolReset.events[0]).toMatchObject({ type: "reset", seq: V3_CURSOR_BASE });
  expectSameReplay(ctx, [1, cursor, oldest - 2, oldest - 1, oldest]);
});

test("multi-byte and invalid UTF-8 text keeps the indexed offsets exact", () => {
  const ctx = fakeCtx();
  appendOutbox(ctx, [alert(1, "Tiếng Việt 🚀"), alert(2, "日本語")]);
  appendFileSync(outboxPath(ctx), Buffer.from([0xe2, 0x82, 0x0a, 0xff, 0x0a]));
  appendOutbox(ctx, [alert(3, "naïve ✓")]);
  expect(eventsSince(ctx, 0, 2).events.map(e => e.seq)).toEqual([1, 2, 3]);
  appendOutbox(ctx, [alert(4, "über 🚀"), alert(5)]);
  expect(eventsSince(ctx, 3, 2).events.map(e => [e.seq, (e.data as { body: string }).body])).toEqual([[4, "über 🚀"], [5, ""]]);
  expect(eventsSince(ctx, 4, 2).events.map(e => e.seq)).toEqual([5]);
  expectSameReplay(ctx, [0, 1, 2, 3, 4, 5]);
});

test("an unterminated last line is replayed when it is complete and not before", () => {
  const ctx = fakeCtx();
  appendOutbox(ctx, [alert(1), alert(2)]);
  expect(eventsSince(ctx, 0, 2).last).toBe(2);
  const third = line(3, alert(3).envelope);
  appendFileSync(outboxPath(ctx), third.slice(0, 20));
  expect(eventsSince(ctx, 2, 2).events).toEqual([]);
  appendFileSync(outboxPath(ctx), third.slice(20, -1));
  expect(eventsSince(ctx, 2, 2).events.map(e => e.seq)).toEqual([3]);
  appendFileSync(outboxPath(ctx), `\n${line(4, alert(4).envelope)}`);
  expect(eventsSince(ctx, 2, 2).events.map(e => e.seq)).toEqual([3, 4]);
  expectSameReplay(ctx, [0, 2, 3]);
});
