import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDesktopCoordinator } from '../src/update/desktop/coordinator';
import { reserveFence, readFence, releaseFence } from '../src/update/desktop/reconciliation-fence';
import { beginWorkSync, finishWorkSync, reserveIdle, releaseReservation } from '../src/update/desktop/admission';

function home() { return mkdtempSync(join(tmpdir(), 'pacer-fence-')); }
function ctx(pacerHome: string) { return { pacerHome } as any; }
const modulePath = new URL('../src/update/desktop/reconciliation-fence.ts', import.meta.url).pathname;
function child(pacerHome: string, code: string) {
  return Bun.spawn([process.execPath, '-e', `import { reserveFence, readFence, releaseFence } from ${JSON.stringify(modulePath)}; const ctx = {pacerHome: ${JSON.stringify(pacerHome)}}; ${code}`], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PACER_HOME: pacerHome } });
}

test('competing processes serialize reservation and reject stale CAS', async () => {
  const dir = home();
  try {
    const procs = ['a', 'b'].map(id => child(dir, `try { reserveFence(ctx, 0, '${id}'); console.log('won'); } catch { console.log('lost'); }`));
    const results = await Promise.all(procs.map(async p => { const output = await new Response(p.stdout).text(); await p.exited; return output.trim(); }));
    expect(results.sort()).toEqual(['lost', 'won']);
    const snapshot = readFence(ctx(dir));
    expect(snapshot.epoch).toBe(1);
    expect(() => reserveFence(ctx(dir), 0, 'stale')).toThrow();
    expect(() => releaseFence(ctx(dir), snapshot)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crashed owner and changed boot retain the reservation and reject release', async () => {
  const dir = home();
  try {
    const p = child(dir, `reserveFence(ctx, 0, 'crash'); process.exit(0);`);
    expect(await p.exited).toBe(0);
    const snapshot = readFence(ctx(dir));
    expect(snapshot.transaction).toBe('crash');
    expect(() => beginWorkSync(ctx(dir), { kind: 'launch', id: 'after-crash', label: 'after crash' })).toThrow();
    expect(() => releaseFence(ctx(dir), snapshot)).toThrow();
    withDesktopCoordinator(ctx(dir), db => db.query("UPDATE reconciliation_fence SET boot_id = 'different-boot' WHERE id = 1").run());
    expect(() => reserveFence(ctx(dir), snapshot.epoch, 'new')).toThrow();
    expect(() => releaseFence(ctx(dir), readFence(ctx(dir)))).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fence excludes leases and legacy reservations in both directions', async () => {
  const dir = home();
  try {
    const c = ctx(dir), blocker = { kind: 'launch' as const, id: 'test', label: 'test' };
    const lease = beginWorkSync(c, blocker);
    expect(() => reserveFence(c, 0, 'tx')).toThrow();
    finishWorkSync(c, lease);
    expect((await reserveIdle(c, 'ota')).reserved).toBe(true);
    expect(() => reserveFence(c, 0, 'tx')).toThrow();
    await releaseReservation(c, 'ota');
    const held = reserveFence(c, 0, 'tx');
    expect(() => beginWorkSync(c, blocker)).toThrow();
    await expect(reserveIdle(c, 'ota')).rejects.toThrow();
    releaseFence(c, held);
    finishWorkSync(c, beginWorkSync(c, blocker));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cross-process work and reservation cannot both win', async () => {
  const dir = home();
  try {
    const admission = new URL('../src/update/desktop/admission.ts', import.meta.url).pathname;
    const work = Bun.spawn([process.execPath, '-e', `import {beginWorkSync} from ${JSON.stringify(admission)}; try {beginWorkSync({pacerHome:${JSON.stringify(dir)}}, {kind:'launch',id:'race',label:'race'}); console.log('won')} catch {console.log('lost')}`], {stdout:'pipe', stderr:'pipe', env:{...process.env,PACER_HOME:dir}});
    const fence = child(dir, `try { reserveFence(ctx, 0, 'race'); console.log('won'); } catch { console.log('lost'); }`);
    const results = await Promise.all([work, fence].map(async p => { const out = await new Response(p.stdout).text(); expect(await p.exited).toBe(0); return out.trim(); }));
    expect(results.sort()).toEqual(['lost', 'won']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(['row', 'table'])('lost fence %s fails closed across restart', async loss => {
  const dir = home();
  try {
    const c = ctx(dir), held = reserveFence(c, 0, 'held');
    withDesktopCoordinator(c, db => db.exec(loss === 'row' ? 'DELETE FROM reconciliation_fence' : 'DROP TABLE reconciliation_fence'));
    expect(() => readFence(c)).toThrow();
    expect(() => beginWorkSync(c, { kind: 'launch', id: 'lost', label: 'lost' })).toThrow();
    expect(() => reserveFence(c, 0, 'new')).toThrow();
    await expect(reserveIdle(c, 'ota')).rejects.toThrow();
    expect(() => releaseFence(c, held)).toThrow();
    const p = child(dir, `try { readFence(ctx); console.log('open') } catch { console.log('closed') }`);
    expect((await new Response(p.stdout).text()).trim()).toBe('closed');
    expect(await p.exited).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unversioned fence is ambiguous and fails closed', () => {
  const dir = home();
  try {
    const c = ctx(dir);
    releaseFence(c, reserveFence(c, 0, 'old'));
    withDesktopCoordinator(c, db => db.exec('PRAGMA user_version = 0'));
    expect(() => readFence(c)).toThrow();
    expect(() => beginWorkSync(c, { kind: 'launch', id: 'ambiguous', label: 'ambiguous' })).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy admission remains usable and explicit initialization preserves it', async () => {
  const dir = home();
  try {
    const c = ctx(dir), blocker = { kind: 'launch' as const, id: 'legacy', label: 'legacy' };
    withDesktopCoordinator(c, db => {
      db.exec('CREATE TABLE admission (id INTEGER PRIMARY KEY, state TEXT NOT NULL)');
      db.query('INSERT INTO admission VALUES (1, ?)').run(JSON.stringify({ schema: 1, reservation: null, leases: [] }));
    });
    finishWorkSync(c, beginWorkSync(c, blocker));
    expect((await reserveIdle(c, 'ota')).reserved).toBe(true);
    await releaseReservation(c, 'ota');
    expect(readFence(c)).toEqual({ epoch: 0, transaction: null, owner: null });
    const held = reserveFence(c, 0, 'new');
    expect(() => beginWorkSync(c, blocker)).toThrow();
    releaseFence(c, held);
    expect(() => reserveFence(c, 0, 'stale')).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent explicit initialization produces one fresh fence', async () => {
  const dir = home();
  try {
    const procs = [child(dir, "console.log(JSON.stringify(readFence(ctx)))"), child(dir, "console.log(JSON.stringify(readFence(ctx)))")];
    for (const p of procs) {
      expect(JSON.parse(await new Response(p.stdout).text())).toEqual({ epoch: 0, transaction: null, owner: null });
      expect(await p.exited).toBe(0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('empty unversioned fence table is ambiguous', () => {
  const dir = home();
  try {
    const c = ctx(dir);
    withDesktopCoordinator(c, db => db.exec('CREATE TABLE reconciliation_fence (id INTEGER PRIMARY KEY)'));
    expect(() => readFence(c)).toThrow();
    expect(() => beginWorkSync(c, { kind: 'launch', id: 'ambiguous', label: 'ambiguous' })).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(['row', 'table'])('lost initialized legacy admission %s cannot prove idle', async loss => {
  const dir = home();
  try {
    const c = ctx(dir);
    beginWorkSync(c, { kind: 'launch', id: 'active', label: 'active' });
    readFence(c);
    withDesktopCoordinator(c, db => db.exec(loss === 'row' ? 'DELETE FROM admission' : 'DROP TABLE admission'));
    expect(() => reserveFence(ctx(dir), 0, 'unsafe')).toThrow();
    expect(() => beginWorkSync(ctx(dir), { kind: 'launch', id: 'new', label: 'new' })).toThrow();
    await expect(reserveIdle(ctx(dir), 'ota')).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
