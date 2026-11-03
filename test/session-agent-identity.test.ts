import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fakeCtx } from './helpers';
import * as readonly from '../src/dispatch/readonly';
import { activeAgentSessions, agentSessionsRevision } from '../src/session/agents-state';

function fixture() {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, 'state'), {recursive: true});
  const path = join(ctx.pacerHome, 'state', 'tasks.db');
  const make = (target: string, id: string) => {
    const db = new Database(target);
    db.run('CREATE TABLE tasks(id TEXT); CREATE TABLE agent_session_revision(id INTEGER PRIMARY KEY,generation INTEGER); INSERT INTO agent_session_revision VALUES(1,1); CREATE TABLE agent_sessions(id TEXT,record TEXT)');
    db.query('INSERT INTO agent_sessions VALUES(?,?)').run(id, JSON.stringify({id, task_id: 'task', state: 'starting', attempt: 1, rev: 1, cwd: ctx.home}));
    db.close();
  };
  make(path, 'old');
  make(path + '.next', 'replacement');
  return {ctx, path};
}

for (const phase of ['open', 'rows'] as const) {
  for (const process of ['local', 'child'] as const) {
    test(`same-generation replacement during ${phase} (${process}) fails closed without poisoning the cache`, () => {
      // Removing the acquisition guard must fail this test even when SQLite itself
      // happens to reject reads on an unlinked handle in the open-phase variant.
      for (let iteration = 0; iteration < 8; iteration++) {
        const f = fixture();
        const original = readonly.openReadOnlyStore;
        let injected = false;
        const replace = () => {
          injected = true;
          if (process === 'local') renameSync(f.path + '.next', f.path);
          else {
            const child = Bun.spawnSync([Bun.which('bun')!, '-e', 'require("node:fs").renameSync(process.argv[1],process.argv[2])', f.path + '.next', f.path]);
            expect(child.exitCode).toBe(0);
          }
        };
        const spy = spyOn(readonly, 'openReadOnlyStore').mockImplementation((ctx, strict) => {
          const db = original(ctx, strict);
          if (!injected && phase === 'open') {
            db.query('SELECT record FROM agent_sessions');
            replace();
          } else if (!injected) {
            const query = db.query;
            db.query = <T>(sql: string, ...bindings: (string | number)[]): T[] => {
              const rows = query<T>(sql, ...bindings);
              if (!injected && sql.includes('SELECT record')) replace();
              return rows;
            };
          }
          return db;
        });
        try {
          const read = iteration % 2 ? agentSessionsRevision : activeAgentSessions;
          expect(() => read(f.ctx)).toThrow(expect.objectContaining({code: 'conflict'}));
        } finally {spy.mockRestore();}
        expect(injected).toBe(true);
        for (let read = 0; read < 4; read++) expect(activeAgentSessions(f.ctx).map(s => s.id)).toEqual(['replacement']);
        const revision = agentSessionsRevision(f.ctx);
        expect(agentSessionsRevision(f.ctx)).toBe(revision);
      }
    }, 30000);
  }
}

test('rename-away/restore rejects an intervening snapshot even when the pathname inode returns', () => {
  const f = fixture();
  const original = readonly.openReadOnlyStore;
  const spy = spyOn(readonly, 'openReadOnlyStore').mockImplementation((ctx, strict) => {
    renameSync(f.path, f.path + '.held');
    renameSync(f.path + '.next', f.path);
    const db = original(ctx, strict);
    db.query('SELECT record FROM agent_sessions');
    renameSync(f.path, f.path + '.next');
    renameSync(f.path + '.held', f.path);
    return db;
  });
  try {expect(() => activeAgentSessions(f.ctx)).toThrow(expect.objectContaining({code: 'conflict'}));}
  finally {spy.mockRestore();}
  expect(activeAgentSessions(f.ctx).map(s => s.id)).toEqual(['old']);
});

test('missing stores stay read-only and legacy stores see each mutation', () => {
  const empty = fakeCtx();
  expect(activeAgentSessions(empty)).toEqual([]);
  expect(agentSessionsRevision(empty)).toBe(agentSessionsRevision(empty));
  const f = fixture();
  const db = new Database(f.path);
  try {
    db.run('DROP TABLE agent_session_revision');
    expect(activeAgentSessions(f.ctx)[0]!.attempt).toBe(1);
    db.run("UPDATE agent_sessions SET record=json_set(record,'$.attempt',2)");
    expect(activeAgentSessions(f.ctx)[0]!.attempt).toBe(2);
  } finally {db.close();}
});
