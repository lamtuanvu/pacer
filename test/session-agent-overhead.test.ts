import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeCtx, tmpDir } from './helpers';
import { createTask, taskDatabase } from '../src/tasks/store';
import { listAgentSessions, type StoredAgentSession } from '../src/session/agents';
import { activeAgentSessions, agentSessionsRevision, agentWorkspaceBusy } from '../src/session/agents-state';
import { apiTasks } from '../src/api/read-model/tasks';
import { slotUse } from '../src/engine/slots';
import { pumpOnce, type PumpDeps } from '../src/link/pump';
import { publish } from '../src/link/publish';
import * as runs from '../src/supervisor/run';

function history(count: number) {
  const ctx = fakeCtx(), repo = tmpDir();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, 'strategy.yaml'), 'planner: claude-code\nproviders: {}\n');
  const task = createTask(ctx, {brief: {goal: 'History overhead', repo}, kind: null, requestedExecutor: null, timeoutS: 30});
  listAgentSessions(ctx); // Install the real registry and durable generation triggers.
  const db = taskDatabase(ctx);
  const insert = (id: string, state: StoredAgentSession['state'], exit?: string) => {
    const dir = join(ctx.pacerHome, 'agent-sessions', id, '1');
    mkdirSync(dir, {recursive: true});
    if (exit !== undefined) writeFileSync(join(dir, 'exit'), exit);
    const record: StoredAgentSession = {id, task_id: task.id, ordinal: 1, executor: 'codex', request: 'History', cwd: repo, createdAt: ctx.now, rev: 1, attempt: 1, state, attempts: [{number: 1, state}]};
    db.query('INSERT INTO agent_sessions(id,task,request_id,payload,record) VALUES(?,?,?,?,?)').run(id, task.id, id, '{}', JSON.stringify(record));
    return dir;
  };
  db.transaction(() => {for (let i = 0; i < count; i++) insert(`history-${i}`, 'running', '0');}).immediate();
  const deps: PumpDeps = {
    status: async () => ({generatedAt: ctx.now, strategy: 'fixture', planner: 'claude-code', mode: 'normal', disabled: false, calendarPace: false, providers: [], executors: {ranked: [], excluded: []}}) as any,
    tasks: () => [task], publish, setup: async () => ({}) as any, probeHosts: async () => [], backfillRepos: async () => {},
  };
  const cycle = async () => {
    expect(apiTasks({...ctx}, [task])[0]!.activeAgentSessions).toBeUndefined();
    expect(slotUse([], {...ctx}).local).toBe(0);
    expect(agentWorkspaceBusy({...ctx}, repo)).toBe(false);
    await pumpOnce({...ctx}, deps);
  };
  return {ctx, task, db, insert, cycle};
}

test('natural exit evidence retires history from read-model, slot, workspace and pump probes', async () => {
  const f = history(12);
  await f.cycle();
  // Instrument the real reader without replacing it: warm idle work must not
  // perform filesystem/process probes for immutable, explicitly exited attempts.
  const probe = spyOn(runs, 'readRun');
  try {
    await f.cycle();
    expect(probe.mock.calls).toHaveLength(0);
  } finally {probe.mockRestore();}
});

test('ambiguous starting and missing-pid failed/running attempts remain observable across reads', async () => {
  const f = history(0);
  const starting = f.insert('starting', 'starting', '0');
  const failed = f.insert('failed', 'failed');
  const running = f.insert('running', 'running');
  expect(activeAgentSessions(f.ctx).map(s => s.id)).toEqual(['starting']);
  const before = agentSessionsRevision(f.ctx);
  for (const dir of [failed, running]) {
    // Real detached wrapper, not a mocked liveness result. Late pid publication
    // must not be lost just because a preceding read saw no live process.
    expect(runs.startRun({dir, argv: ['/bin/sleep', '1'], cwd: f.ctx.home, env: {HOME: f.ctx.home, PACER_HOME: f.ctx.pacerHome}, session: 'pipe'})).toHaveProperty('pid');
  }
  expect(activeAgentSessions({...f.ctx}).map(s => s.id).sort()).toEqual(['failed', 'running', 'starting']);
  const liveRevision = agentSessionsRevision({...f.ctx});
  expect(liveRevision).not.toBe(before);
  expect(starting).toBeTruthy();
  await Promise.all([failed, running].map(dir => runs.stopRun(dir, {graceMs: 2000})));
  // A task read can observe/retire the exit before the pump. The pump must still
  // emit its changed revision, rather than losing the event to the shared cache.
  expect(activeAgentSessions({...f.ctx}).map(s => s.id)).toEqual(['starting']);
  const endedRevision = agentSessionsRevision({...f.ctx});
  expect(endedRevision).not.toBe(liveRevision);
  expect(agentSessionsRevision({...f.ctx})).toBe(endedRevision);
});

test('durable mutations revive a retired session on its new attempt without exposing mutable cache records', () => {
  const f = history(1);
  expect(activeAgentSessions(f.ctx)).toEqual([]);
  const row = f.db.query<{record:string}, []>('SELECT record FROM agent_sessions').get()!;
  const record = {...JSON.parse(row.record), attempt: 2, rev: 2, state: 'starting'};
  f.db.query('UPDATE agent_sessions SET record=?').run(JSON.stringify(record));
  const active = activeAgentSessions({...f.ctx});
  expect(active).toHaveLength(1);
  expect(active[0]!.attempt).toBe(2);
  active[0]!.state = 'ended';
  active[0]!.attempt = 99;
  expect(activeAgentSessions({...f.ctx})[0]).toMatchObject({state: 'starting', attempt: 2});
  const before = agentSessionsRevision(f.ctx);
  record.state = 'ended'; record.rev++;
  f.db.query('UPDATE agent_sessions SET record=?').run(JSON.stringify(record));
  expect(activeAgentSessions({...f.ctx})).toEqual([]);
  expect(agentSessionsRevision({...f.ctx})).not.toBe(before);
});

test('benchmark natural-exit stored-running history through real read-model and pump paths', async () => {
  for (const count of [10, 300]) {
    const f = history(count);
    // Launch real short-lived wrappers in bounded batches. The registry remains
    // stored-running after each natural exit, exactly as the production view does.
    for (let offset = 0; offset < count; offset += 10) {
      const dirs = Array.from({length: Math.min(10, count - offset)}, (_, n) => join(f.ctx.pacerHome, 'agent-sessions', `history-${offset + n}`, '1'));
      try {
        for (const dir of dirs) expect(runs.startRun({dir, argv: ['/usr/bin/true'], cwd: f.ctx.home, env: {HOME: f.ctx.home, PACER_HOME: f.ctx.pacerHome}, session: 'pipe'})).toHaveProperty('pid');
        const deadline = Date.now() + 5000;
        while (dirs.some(dir => runs.readRun(dir).exit === null) && Date.now() < deadline) await Bun.sleep(10);
        for (const dir of dirs) expect(runs.readRun(dir).exit).toBe(0);
      } finally {await Promise.all(dirs.filter(dir => runs.readRun(dir).alive).map(dir => runs.stopRun(dir, {graceMs: 500})));}
    }
    const cold = performance.now();
    await f.cycle();
    const coldMs = performance.now() - cold;
    const start = performance.now();
    for (let i = 0; i < 5; i++) await f.cycle();
    console.log(JSON.stringify({benchmark: 'natural-exit-full-path', count, coldMs, warmCycles: 5, warmMs: performance.now() - start}));
  }
}, 120000);
