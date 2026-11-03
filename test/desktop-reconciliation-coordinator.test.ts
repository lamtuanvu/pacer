import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWaitingIntent, cancelWaitingIntent, inspectWaitingIntent } from '../src/update/desktop/reconciliation-store';
import { withDesktopCoordinator } from '../src/update/desktop/coordinator';
import { readFence, reserveFence } from '../src/update/desktop/reconciliation-fence';

const input = { key: 'request-1', candidate: 'candidate', revision: 3, session: 'session', boot: 'boot', installation: 'installation', identity: 'identity', registration: 'registration', expiresAt: 2000 };
const current = { session: 'session', boot: 'boot', installation: 'installation', identity: 'identity', registration: 'registration', now: 1000 };
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'pacer-intent-')); return { dir, ctx: { pacerHome: dir } as any }; }

test('persists an idempotent bounded receipt and rejects replay or stale revision', () => {
  const { dir, ctx } = fixture();
  try {
    const receipt = createWaitingIntent(ctx, input, 0, current);
    expect(createWaitingIntent(ctx, input, 0, current)).toEqual(receipt);
    expect(() => createWaitingIntent(ctx, { ...input, candidate: 'other' }, 0, current)).toThrow();
    expect(() => createWaitingIntent(ctx, { ...input, key: 'other' }, 0, current)).toThrow();
    expect(() => createWaitingIntent(ctx, { ...input, key: 'huge'.repeat(200) }, 1, current)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cancellation is durable and invalidated waiting cannot revive', () => {
  const { dir, ctx } = fixture();
  try {
    const receipt = createWaitingIntent(ctx, input, 0, current);
    expect(cancelWaitingIntent(ctx, receipt.id, receipt.revision, current).state).toBe('cancelled');
    expect(inspectWaitingIntent(ctx, receipt.id, current).state).toBe('cancelled');
    expect(() => cancelWaitingIntent(ctx, receipt.id, receipt.revision, current)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(['session', 'boot', 'installation', 'identity', 'registration'] as const)('changed %s expires waiting permanently', field => {
  const { dir, ctx } = fixture();
  try {
    const receipt = createWaitingIntent(ctx, input, 0, current);
    expect(inspectWaitingIntent(ctx, receipt.id, { ...current, [field]: 'changed' }).state).toBe('expired');
    expect(inspectWaitingIntent(ctx, receipt.id, current).state).toBe('expired');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deadline expires waiting and cannot be extended by a retry', () => {
  const { dir, ctx } = fixture();
  try {
    const receipt = createWaitingIntent(ctx, input, 0, current);
    expect(inspectWaitingIntent(ctx, receipt.id, { ...current, now: 2000 }).state).toBe('expired');
    expect(() => createWaitingIntent(ctx, { ...input, expiresAt: 3000 }, 0, current)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('waiting and cancellation leave the fence open and unknown record versions fail closed', () => {
  const { dir, ctx } = fixture();
  try {
    const initial = readFence(ctx);
    const receipt = createWaitingIntent(ctx, input, 0, current);
    expect(readFence(ctx)).toEqual(initial);
    cancelWaitingIntent(ctx, receipt.id, receipt.revision, current);
    expect(readFence(ctx)).toEqual(initial);
    withDesktopCoordinator(ctx, db => {
      const row = db.query('SELECT record FROM reconciliation_intents WHERE id = ?').get(receipt.id) as { record: string };
      const record = JSON.parse(row.record); record.version = 2;
      db.query('UPDATE reconciliation_intents SET record = ? WHERE id = ?').run(JSON.stringify(record), receipt.id);
    });
    expect(() => inspectWaitingIntent(ctx, receipt.id, current)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reclaims expired capacity durably while stale retries and clock rollback fail closed', () => {
  const { dir, ctx } = fixture();
  try {
    let first = createWaitingIntent(ctx, input, 0, current);
    for (let i = 1; i < 256; i++) createWaitingIntent(ctx, { ...input, key: `request-${i + 1}` }, i, current);
    expect(() => createWaitingIntent(ctx, { ...input, key: 'overflow' }, 256, current)).toThrow();
    const later = { ...current, now: 2000, boot: 'new-boot', session: 'new-session' };
    const next = { ...input, key: 'new', boot: later.boot, session: later.session, expiresAt: 3000 };
    expect(createWaitingIntent({ pacerHome: dir } as any, next, 256, later).state).toBe('waiting');
    expect(() => createWaitingIntent({ pacerHome: dir } as any, input, 257, current)).toThrow();
    expect(() => inspectWaitingIntent(ctx, first.id, current)).toThrow();
    expect(() => createWaitingIntent(ctx, { ...input, expiresAt: 3000 }, 257, later)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cancelled and invalidated keys remain reserved until their original deadline', () => {
  const { dir, ctx } = fixture();
  try {
    const first = createWaitingIntent(ctx, input, 0, current);
    cancelWaitingIntent(ctx, first.id, first.revision, current);
    expect(() => createWaitingIntent(ctx, { ...input, expiresAt: 3000 }, 2, current)).toThrow();
    const second = createWaitingIntent(ctx, { ...input, key: 'second' }, 2, current);
    inspectWaitingIntent(ctx, second.id, { ...current, boot: 'other' });
    expect(() => createWaitingIntent(ctx, { ...input, key: 'second', boot: 'other' }, 4, { ...current, boot: 'other' })).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent creators serialize the revision and admit only one', async () => {
  const { dir, ctx } = fixture();
  try {
    createWaitingIntent(ctx, input, 0, current);
    const moduleUrl = new URL('../src/update/desktop/reconciliation-store.ts', import.meta.url).href;
    const source = `import { createWaitingIntent } from ${JSON.stringify(moduleUrl)}; try { createWaitingIntent({pacerHome: process.argv[1]}, {...${JSON.stringify(input)}, key: process.argv[2]}, 1, ${JSON.stringify(current)}); process.exit(0); } catch { process.exit(1); }`;
    const children = ['one', 'two'].map(key => Bun.spawn(['bun', '-e', source, dir, key], { stdout: 'ignore', stderr: 'ignore' }));
    expect((await Promise.all(children.map(child => child.exited))).sort()).toEqual([0, 1]);
    expect(() => createWaitingIntent(ctx, { ...input, key: 'third' }, 1, current)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(['reconciliation_intents', 'reconciliation_intent_revision', 'reconciliation_intent_clock', 'revision row', 'clock row', 'marker row', 'marker table'])('initialized waiting journal loss of %s fails closed after restart', loss => {
  const { dir, ctx } = fixture();
  try {
    const first = createWaitingIntent(ctx, input, 0, current);
    cancelWaitingIntent(ctx, first.id, first.revision, current);
    withDesktopCoordinator(ctx, db => {
      const sql = loss === 'revision row' ? 'DELETE FROM reconciliation_intent_revision' : loss === 'clock row' ? 'DELETE FROM reconciliation_intent_clock' : loss === 'marker row' ? 'DELETE FROM reconciliation_intent_meta' : loss === 'marker table' ? 'DROP TABLE reconciliation_intent_meta' : `DROP TABLE ${loss}`;
      db.exec(sql);
    });
    const restarted = { pacerHome: dir } as any;
    expect(() => createWaitingIntent(restarted, input, 0, current)).toThrow();
    expect(() => createWaitingIntent(restarted, { ...input, key: 'new' }, 2, { ...current, now: 999 })).toThrow();
    expect(() => inspectWaitingIntent(restarted, first.id, current)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(['reconciliation_intents', 'reconciliation_intent_revision', 'reconciliation_intent_clock'])('unversioned waiting table %s is ambiguous', table => {
  const { dir, ctx } = fixture();
  try {
    withDesktopCoordinator(ctx, db => db.exec(`CREATE TABLE ${table} (id INTEGER)`));
    expect(() => createWaitingIntent(ctx, input, 0, current)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent first waiting initialization preserves the fence version and admits one revision', async () => {
  const { dir, ctx } = fixture();
  try {
    expect(readFence(ctx).epoch).toBe(0);
    const moduleUrl = new URL('../src/update/desktop/reconciliation-store.ts', import.meta.url).href;
    const source = `import { createWaitingIntent } from ${JSON.stringify(moduleUrl)}; try { createWaitingIntent({pacerHome: process.argv[1]}, {...${JSON.stringify(input)}, key: process.argv[2]}, 0, ${JSON.stringify(current)}); process.exit(0); } catch { process.exit(1); }`;
    const children = ['one', 'two'].map(key => Bun.spawn([process.execPath, '-e', source, dir, key], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, PACER_HOME: dir } }));
    expect((await Promise.all(children.map(child => child.exited))).sort()).toEqual([0, 1]);
    expect(readFence(ctx)).toEqual({ epoch: 0, transaction: null, owner: null });
    withDesktopCoordinator(ctx, db => expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 1 }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('combined intent and revision loss cannot replay a cancelled key', () => {
  const { dir, ctx } = fixture();
  try {
    const receipt = createWaitingIntent(ctx, input, 0, current);
    cancelWaitingIntent(ctx, receipt.id, receipt.revision, current);
    withDesktopCoordinator(ctx, db => db.exec('DROP TABLE reconciliation_intents; DELETE FROM reconciliation_intent_revision'));
    expect(() => createWaitingIntent({ pacerHome: dir } as any, input, 0, current)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cancellation after reservation is refused without changing the intent or fence', () => {
  const { dir, ctx } = fixture();
  try {
    const receipt = createWaitingIntent(ctx, input, 0, current);
    const reserved = reserveFence(ctx, readFence(ctx).epoch, receipt.id);
    expect(() => cancelWaitingIntent(ctx, receipt.id, receipt.revision, current)).toThrow();
    expect(inspectWaitingIntent(ctx, receipt.id, current)).toEqual(receipt);
    expect(readFence(ctx)).toEqual(reserved);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
