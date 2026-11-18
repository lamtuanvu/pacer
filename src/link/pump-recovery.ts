// A receipt pins the append inode until the pump's SQLite checkpoint commits.
// Rotation (including by Rust/older publishers) replaces the public pathname but
// cannot erase these bytes. No public outbox fields or lock protocol change.
import { closeSync, linkSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../core/lock";
import { writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import type { LedgerRow, PumpLedgerApi } from "./ledger";
import { latestPath, outboxPath } from "./paths";
import { appendOutbox, notifyOutbox, readLatest, readOutboxSince, rotateOutbox, type OutboxEntry } from "./store";
import { reduce, type OutboxEvent } from "./envelope";

interface Receipt { offset: number; entries: OutboxEntry[]; slot: 0 | 1; recovered: LedgerRow[] }
const receiptPath = (ctx: Ctx) => join(ctx.pacerHome, "link", "pump-publish.json");
const pinPath = (ctx: Ctx, slot: number) => join(ctx.pacerHome, "link", `pump-publish-${slot}.jsonl`);
const notificationPath = (ctx: Ctx) => join(ctx.pacerHome, "link", "pump-notifications.json");
/** Durable handoff: status/setup may fail after receipt recovery succeeds. */
export function pendingPumpNotifications(ctx: Ctx): OutboxEvent[] {
  let text: string;
  try { text = readFileSync(notificationPath(ctx), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const events = JSON.parse(text) as OutboxEvent[];
  if (!Array.isArray(events) || events.some(event => event?.type !== "task" || typeof event.data?.id !== "string"))
    throw Error("invalid pending pump notifications");
  return events;
}
export function finishPumpNotifications(ctx: Ctx): void {
  rmSync(notificationPath(ctx), { force: true });
}
function handoffNotifications(ctx: Ctx, rows: LedgerRow[]): void {
  const events: OutboxEvent[] = rows.flatMap(row => row.data ? [{ type: "task", data: row.data }] : []);
  if (!events.length) return;
  const unique = new Map([...pendingPumpNotifications(ctx), ...events].map(event => [JSON.stringify(event), event]));
  writeJsonAtomic(notificationPath(ctx), [...unique.values()]);
}

function readReceipt(ctx: Ctx): Receipt | null {
  let text: string;
  try { text = readFileSync(receiptPath(ctx), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const value = JSON.parse(text) as Receipt;
  if (!value || !Number.isSafeInteger(value.offset) || value.offset < 0 || !Array.isArray(value.entries)
    || !Array.isArray(value.recovered) || (value.slot !== 0 && value.slot !== 1)) throw Error("invalid pump publication receipt");
  return value;
}

/** Alternate two pins so replacing a receipt never removes its evidence first. */
function stage(ctx: Ctx, entries: OutboxEntry[], recovered: LedgerRow[], prior: Receipt | null): void {
  const slot = prior?.slot === 0 ? 1 : 0;
  const pin = pinPath(ctx, slot);
  closeSync(openSync(outboxPath(ctx), "a", 0o600));
  rmSync(pin, { force: true });
  linkSync(outboxPath(ctx), pin);
  writeJsonAtomic(receiptPath(ctx), { offset: statSync(pin).size, entries, slot, recovered } satisfies Receipt);
  if (prior) rmSync(pinPath(ctx, prior.slot), { force: true });
}

/** Called under the existing link lock, immediately before append. */
export function preparePumpPublish(ctx: Ctx, entries: OutboxEntry[]): void {
  if (readReceipt(ctx)) throw Error("pump publication recovery is pending");
  stage(ctx, entries, [], null);
}

/** Clear only after committing the checkpoint (or its recovered published rows). */
export function finishPumpPublish(ctx: Ctx): void {
  rmSync(receiptPath(ctx), { force: true });
  for (const slot of [0, 1]) rmSync(pinPath(ctx, slot), { force: true });
}
const taskRows = (entries: OutboxEntry[]): LedgerRow[] => entries.flatMap(entry => entry.envelope.type === "task"
  ? [{ id: entry.envelope.data.id, state: entry.envelope.data.state, data: entry.envelope.data, eventAt: entry.at }]
  : []);

/** Recover before selection. Keep the cursor unchanged so reconciliation rebuilds
 * membership. A complete prefix proves publication; a missing suffix (including
 * terminal alerts after a task event) is journaled again before being appended.
 */
export async function recoverPumpPublish(ctx: Ctx, ledger: PumpLedgerApi): Promise<OutboxEvent[]> {
  if (!readReceipt(ctx)) return [];
  return withLock(ctx, "link", () => {
    const pending = readReceipt(ctx);
    if (!pending) return [];
    const replayed: OutboxEvent[] = [];
    const fd = openSync(pinPath(ctx, pending.slot), "r"); // missing evidence fails closed
    let count = 0;
    try {
      let offset = pending.offset;
      for (const entry of pending.entries) {
        const expected = Buffer.from(`${JSON.stringify(entry)}\n`);
        const actual = Buffer.alloc(expected.length);
        const size = readSync(fd, actual, 0, actual.length, offset);
        const jsonLength = expected.length - 1;
        // Replay readers accept a complete final JSON object without a newline.
        // Another publisher may since have concatenated its append to that tail;
        // the pinned complete object still proves this event was observable.
        if (size < jsonLength || !actual.subarray(0, jsonLength).equals(expected.subarray(0, jsonLength))) break;
        count++;
        offset += jsonLength + (size > jsonLength && actual[jsonLength] === 10 ? 1 : 0);
      }
    } finally { closeSync(fd); }
    // An interruption after append can leave latest behind. Repair it under the
    // cross-runtime lock before either replaying a suffix or comparing task data.
    let snapshot = readLatest(ctx);
    const before = snapshot.seq;
    for (const entry of readOutboxSince(ctx, before)) {
      if (entry.seq !== snapshot.seq + 1) throw Error("outbox sequence gap during pump recovery");
      snapshot = reduce(snapshot, entry.envelope, entry.at ?? ctx.now);
    }
    if (snapshot.seq !== before) writeJsonAtomic(latestPath(ctx), snapshot);
    const recovered = [...pending.recovered, ...taskRows(pending.entries.slice(0, count))];
    if (count < pending.entries.length) {
      // Never concatenate replay onto a torn JSON line. Repairing arbitrary torn
      // writes is a shared outbox concern; preserve the receipt and fail closed.
      const tail = openSync(outboxPath(ctx), "r");
      try {
        const size = statSync(outboxPath(ctx)).size;
        const last = Buffer.alloc(1);
        if (size && (readSync(tail, last, 0, 1, size - 1) !== 1 || last[0] !== 10))
          throw Error("outbox has an incomplete line; pump receipt retained for recovery");
      } finally { closeSync(tail); }
      const suffix = pending.entries.slice(count).map(entry => {
        snapshot = reduce(snapshot, entry.envelope, entry.at ?? ctx.now);
        return { ...entry, seq: snapshot.seq };
      });
      stage(ctx, suffix, recovered, pending);
      appendOutbox(ctx, suffix, false, false);
      writeJsonAtomic(latestPath(ctx), snapshot);
      rotateOutbox(ctx);
      notifyOutbox(ctx);
      recovered.push(...taskRows(suffix));
      replayed.push(...suffix.map(entry => entry.envelope));
    }
    ledger.writeLedger(ctx, recovered);
    handoffNotifications(ctx, recovered);
    finishPumpPublish(ctx);
    return replayed;
  }, { timeoutMs: 5000 });
}
