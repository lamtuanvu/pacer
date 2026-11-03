import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Ctx } from '../../types';
import { CoreError } from '../../core/errors';
import { withDesktopCoordinator } from './coordinator';
import { optionalFence } from './reconciliation-fence';

// This journal is bookkeeping, not proof of consent, peer identity or authority.
// It is not connected to admission, a coordinator, a helper or any public API.
const text = z.string().min(1).max(256);
const counter = z.number().int().nonnegative().safe();
const inputSchema = z.object({ key: text, candidate: text, revision: counter, session: text, boot: text, installation: text, identity: text, registration: text, expiresAt: counter }).strict();
const contextSchema = z.object({ session: text, boot: text, installation: text, identity: text, registration: text, now: counter }).strict();
type Input = z.infer<typeof inputSchema>;
type Current = z.infer<typeof contextSchema>;
const recordSchema = z.object({ version: z.literal(1), id: text, input: inputSchema, revision: counter, state: z.enum(['waiting', 'cancelled', 'expired']) }).strict();
type RecordRow = z.infer<typeof recordSchema>;
export type WaitingReceipt = { id: string; revision: number; state: RecordRow['state'] };
const MAX_LIFETIME_MS = 15 * 60 * 1000;
const MAX_RECORDS = 256;
function conflict(): never { throw new CoreError('conflict', 'Reconciliation intent conflict or unavailable state'); }
function init(db: Database) {
  const names = ['reconciliation_intents', 'reconciliation_intent_revision', 'reconciliation_intent_clock', 'reconciliation_intent_meta'];
  const present = names.map(name => !!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  if (!present[3]) {
    // Unversioned tables may contain lost replay evidence; never migrate them.
    if (present.some(Boolean)) return conflict();
    db.exec('CREATE TABLE reconciliation_intent_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL); INSERT INTO reconciliation_intent_meta VALUES (1, 1); CREATE TABLE reconciliation_intents (id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, record TEXT NOT NULL); CREATE TABLE reconciliation_intent_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL); INSERT INTO reconciliation_intent_revision VALUES (1, 0); CREATE TABLE reconciliation_intent_clock (id INTEGER PRIMARY KEY CHECK (id = 1), watermark INTEGER NOT NULL); INSERT INTO reconciliation_intent_clock VALUES (1, 0)');
  } else if (!present.every(Boolean)) return conflict();
  const marker = z.object({ version: z.literal(1) }).safeParse(db.query('SELECT version FROM reconciliation_intent_meta WHERE id = 1').get());
  if (!marker.success) return conflict();
  // Validate both singletons before any operation, including idempotent retries.
  revision(db);
  const clock = z.object({ watermark: counter }).safeParse(db.query('SELECT watermark FROM reconciliation_intent_clock WHERE id = 1').get());
  if (!clock.success) return conflict();
}
// Retain every key (including cancelled/invalidated tombstones) through its
// original deadline, at most 15 minutes after creation. Pruning and advancing
// this durable watermark share the coordinator transaction. A clock rollback,
// including after a reboot, fails closed; callers must supply trusted time.
// This bookkeeping alone is not a grant or a replay defense for future effects.
function checkClock(db: Database, now: number): void {
  const row = z.object({ watermark: counter }).safeParse(db.query('SELECT watermark FROM reconciliation_intent_clock WHERE id = 1').get());
  if (!row.success || now < row.data.watermark) return conflict();
  if (db.query('UPDATE reconciliation_intent_clock SET watermark = ? WHERE id = 1').run(now).changes !== 1) conflict();
}
function prune(db: Database, now: number): void {
  const rows = db.query('SELECT id, request_key, record FROM reconciliation_intents').all();
  for (const raw of rows) {
    const wrapper = z.object({ id: text, request_key: text, record: z.string().max(8192) }).strict().safeParse(raw);
    if (!wrapper.success) return conflict();
    const row = parse({ record: wrapper.data.record });
    if (row.id !== wrapper.data.id || row.input.key !== wrapper.data.request_key) return conflict();
    if (row.input.expiresAt <= now) db.query('DELETE FROM reconciliation_intents WHERE id = ?').run(row.id);
  }
}
function revision(db: Database): number {
  const row = z.object({ revision: counter }).safeParse(db.query('SELECT revision FROM reconciliation_intent_revision WHERE id = 1').get());
  if (!row.success) return conflict();
  return row.data.revision;
}
function advance(db: Database, expected: number): number {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) return conflict();
  if (db.query('UPDATE reconciliation_intent_revision SET revision = revision + 1 WHERE id = 1 AND revision = ?').run(expected).changes !== 1) return conflict();
  return expected + 1;
}
function parse(row: unknown): RecordRow {
  const wrapper = z.object({ record: z.string().max(8192) }).safeParse(row);
  if (!wrapper.success) return conflict();
  try { const result = recordSchema.safeParse(JSON.parse(wrapper.data.record)); return result.success ? result.data : conflict(); } catch { return conflict(); }
}
function receipt(row: RecordRow): WaitingReceipt { return { id: row.id, revision: row.revision, state: row.state }; }
function checkedCurrent(value: Current): Current { const parsed = contextSchema.safeParse(value); return parsed.success ? parsed.data : conflict(); }
function matches(input: Input, current: Current): boolean {
  return input.session === current.session && input.boot === current.boot && input.installation === current.installation && input.identity === current.identity && input.registration === current.registration && current.now < input.expiresAt;
}
function get(db: Database, id: string): RecordRow { return parse(db.query('SELECT record FROM reconciliation_intents WHERE id = ?').get(id)); }
function save(db: Database, row: RecordRow) { if (db.query('UPDATE reconciliation_intents SET record = ? WHERE id = ?').run(JSON.stringify(row), row.id).changes !== 1) conflict(); }
function expire(db: Database, row: RecordRow, current: Current): RecordRow {
  if (row.state === 'waiting' && !matches(row.input, current)) {
    row = { ...row, state: 'expired', revision: advance(db, revision(db)) };
    save(db, row);
  }
  return row;
}
export function createWaitingIntent(ctx: Ctx, value: Input, expectedRevision: number, currentValue: Current): WaitingReceipt {
  const parsed = inputSchema.safeParse(value), current = checkedCurrent(currentValue);
  if (!parsed.success) return conflict();
  const input = parsed.data;
  if (!matches(input, current) || input.expiresAt - current.now > MAX_LIFETIME_MS) return conflict();
  return withDesktopCoordinator(ctx, db => {
    init(db);
    checkClock(db, current.now);
    prune(db, current.now);
    const existing = db.query('SELECT record FROM reconciliation_intents WHERE request_key = ?').get(input.key);
    if (existing) {
      const row = parse(existing);
      if (JSON.stringify(row.input) !== JSON.stringify(input)) return conflict();
      return receipt(expire(db, row, current));
    }
    const count = db.query('SELECT COUNT(*) AS count FROM reconciliation_intents').get() as { count: number };
    if (count.count >= MAX_RECORDS || revision(db) !== expectedRevision) return conflict();
    const row: RecordRow = { version: 1, id: randomUUID(), input, revision: advance(db, expectedRevision), state: 'waiting' };
    db.query('INSERT INTO reconciliation_intents (id, request_key, record) VALUES (?, ?, ?)').run(row.id, input.key, JSON.stringify(row));
    return receipt(row);
  });
}
export function inspectWaitingIntent(ctx: Ctx, id: string, currentValue: Current): WaitingReceipt {
  const current = checkedCurrent(currentValue);
  if (!text.safeParse(id).success) return conflict();
  return withDesktopCoordinator(ctx, db => { init(db); checkClock(db, current.now); return receipt(expire(db, get(db, id), current)); });
}
export function cancelWaitingIntent(ctx: Ctx, id: string, expectedRevision: number, currentValue: Current): WaitingReceipt {
  const current = checkedCurrent(currentValue);
  if (!text.safeParse(id).success) return conflict();
  return withDesktopCoordinator(ctx, db => {
    init(db);
    checkClock(db, current.now);
    let row = get(db, id);
    // Serialize cancellation against reservation under the same coordinator lock.
    // An active reservation is ambiguous until the authenticated transfer exists.
    if (optionalFence(db)?.transaction) return conflict();
    // A mismatch cannot cancel or revive a different session's intent.
    if (row.state !== 'waiting' || row.revision !== expectedRevision || !matches(row.input, current)) return conflict();
    row = { ...row, state: 'cancelled', revision: advance(db, revision(db)) };
    save(db, row);
    return receipt(row);
  });
}
