import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeCtx, gitRepo, realRun } from './helpers';
import { createTask, readTask, taskDatabase, updateTask } from '../src/tasks/store';
import { createAgentSession } from '../src/session/agents';
import { agentCheckDirectory, agentChecksPending, pendingAgentChecks, settleAgentSessionChecks, stopAgentSessionChecks } from '../src/session/agents-checks';
import { agentWorkspaceBusy } from '../src/session/agents-state';
import { stopRunningWork } from '../src/service/running-work';
import { withLock } from '../src/core/lock';
import { readRun, stopRun } from '../src/supervisor/run';
import { Database } from 'bun:sqlite';

async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw Error('checker stop fixture deadline');
    await Bun.sleep(10);
  }
}

async function fixture(acceptance = 'echo started > stop-started; sleep 1; echo completed > stop-completed') {
  const ctx = fakeCtx({ run: realRun }), repo = gitRepo();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, 'strategy.yaml'), 'planner: claude-code\nproviders:\n  codex: {usage: reactive}\n');
  const task = createTask(ctx, { brief: { goal: 'Stop checks', repo, acceptance }, kind: null, requestedExecutor: 'codex', timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = 'done'; t.backend = 'direct'; t.worktree = repo; });
  await createAgentSession(ctx, { task_id: task.id, request_id: 'stop-check', executor: 'codex', request: 'Review' }, {
    launch: async (_ctx, s) => ({ argv: ['fixture'], cwd: s.cwd, env: {} }), start: () => ({ pid: 12345 }),
  });
  const check = pendingAgentChecks(ctx)[0]!;
  const cancelled = () => {
    const db = taskDatabase(ctx);
    if (!db.query<{ name: string }, []>('PRAGMA table_info(agent_session_checks)').all().some(c => c.name === 'cancelled')) return false;
    return db.query<{ cancelled: number }, [string]>('SELECT cancelled FROM agent_session_checks WHERE task=?').get(task.id)?.cancelled === check.generation;
  };
  return { ctx, repo, task, check, cancelled };
}

test('Stop all durably cancels before checker claim without releasing its clean reservation', async () => {
  const { ctx, repo, task, check, cancelled } = await fixture();
  let checking!: Promise<void>, stopping!: ReturnType<typeof stopRunningWork>;
  try {
    await withLock(ctx, 'session-create', async () => {
      checking = settleAgentSessionChecks(ctx);
      await until(() => existsSync(join(ctx.pacerHome, 'orca', 'agent-sessions.lock')));
      stopping = stopRunningWork(ctx);
      await until(cancelled, 1000);
      expect(agentWorkspaceBusy({ ...ctx }, repo, 'other-task')).toBe(true);
      expect(existsSync(join(repo, 'stop-started'))).toBe(false);
    });
  } finally {
    await checking;
    if (stopping) await stopping;
    await stopRun(agentCheckDirectory(ctx, check), { graceMs: 100 });
  }
  expect(existsSync(join(repo, 'stop-started'))).toBe(false);
  expect(await stopping).toEqual({ stopped: [task.id], skipped: [] });
  expect(agentChecksPending(ctx, task.id)).toBe(false);
  expect(readTask(ctx, task.id)?.result?.acceptance).toBeUndefined();
}, 15000);

test('Stop all cancels between claim and spawn while verification awaits Git', async () => {
  const { ctx, repo, task, check, cancelled } = await fixture();
  const bin = join(ctx.home, 'gate-bin'), gate = join(ctx.home, 'git-gate'), ready = join(ctx.home, 'git-ready');
  mkdirSync(bin);
  ctx.env = { ...ctx.env, PATH: `${bin}:${process.env.PATH}`, REAL_GIT: Bun.which('git')!, CHECK_GATE: gate, CHECK_READY: ready };
  writeFileSync(join(bin, 'git'), '#!/bin/sh\ncase " $* " in *" status "*) : > "$CHECK_READY"; n=0; while [ ! -f "$CHECK_GATE" ] && [ "$n" -lt 500 ]; do sleep 0.01; n=$((n+1)); done;; esac\nexec "$REAL_GIT" "$@"\n', { mode: 0o700 });
  const checking = settleAgentSessionChecks(ctx);
  let stopping: ReturnType<typeof stopRunningWork> | undefined;
  try {
    await until(() => existsSync(ready));
    expect(pendingAgentChecks(ctx)[0]?.checking).toBe(1);
    stopping = stopRunningWork(ctx);
    await until(cancelled, 1000);
    expect(agentWorkspaceBusy(ctx, repo, 'other-task')).toBe(true);
  } finally {
    writeFileSync(gate, 'release');
    await checking;
    if (stopping) await stopping;
    await stopRun(agentCheckDirectory(ctx, check), { graceMs: 100 });
  }
  expect(existsSync(join(repo, 'stop-started'))).toBe(false);
  expect(await stopping).toEqual({ stopped: [task.id], skipped: [] });
  expect(readTask(ctx, task.id)?.result?.acceptance).toBeUndefined();
}, 15000);

test('Stop all terminates a running checker and reports it once without publishing acceptance', async () => {
  const { ctx, repo, task, check } = await fixture('echo started > stop-started; sleep 30; echo completed > stop-completed');
  const checking = settleAgentSessionChecks(ctx);
  try {
    await until(() => existsSync(join(repo, 'stop-started')));
    expect(readRun(agentCheckDirectory(ctx, check)).alive).toBe(true);
    expect(await stopRunningWork(ctx)).toEqual({ stopped: [task.id], skipped: [] });
    await checking;
    expect(readRun(agentCheckDirectory(ctx, check)).alive).toBe(false);
    expect(existsSync(join(repo, 'stop-completed'))).toBe(false);
    expect(readTask(ctx, task.id)?.result?.acceptance).toBeUndefined();
    expect(agentWorkspaceBusy(ctx, repo, 'other-task')).toBe(false);
  } finally {
    await stopRun(agentCheckDirectory(ctx, check), { graceMs: 100 });
    await checking;
  }
}, 15000);

test('Stop all during actual diff capture retains checkout until capture ends and reports cancelled work', async () => {
  const { ctx, repo, task, cancelled } = await fixture('echo completed > stop-completed');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => release = r), ready = new Promise<void>(r => entered = r);
  ctx.run = async (argv, timeout, options) => {
    if (argv.includes('--name-status')) { entered(); await gate; }
    return realRun(argv, timeout, options);
  };
  const checking = settleAgentSessionChecks(ctx);
  let stopping: ReturnType<typeof stopRunningWork> | undefined, stopped = false;
  try {
    await ready;
    stopping = stopRunningWork(ctx).then(report => { stopped = true; return report; });
    await until(cancelled, 1000);
    expect(stopped).toBe(false);
    expect(agentWorkspaceBusy({ ...ctx }, repo, 'other-task')).toBe(true);
    expect(existsSync(join(ctx.pacerHome, 'orca', `clean-${task.id}.lock`))).toBe(true);
  } finally {
    release();
    await checking;
    if (stopping) await stopping;
  }
  expect(await stopping).toEqual({ stopped: [task.id], skipped: [] });
  expect(existsSync(join(ctx.pacerHome, 'runs', task.id, '0', 'diff.json'))).toBe(true);
  expect(readTask(ctx, task.id)?.result?.acceptance).toBeUndefined();
  expect(agentWorkspaceBusy(ctx, repo, 'other-task')).toBe(false);
}, 15000);

test('an old stop cannot cancel a later session generation', async () => {
  const { ctx, repo, task, check } = await fixture('echo completed > stop-completed');
  expect(await stopAgentSessionChecks(ctx, task.id, check.generation)).toBe(true);
  await createAgentSession(ctx, { task_id: task.id, request_id: 'fresh-after-stop', executor: 'codex', request: 'Review again' }, {
    launch: async (_ctx, s) => ({ argv: ['fixture'], cwd: s.cwd, env: {} }), start: () => ({ pid: 12345 }),
  });
  expect(pendingAgentChecks(ctx)[0]?.generation).toBe(check.generation + 1);
  expect(await stopAgentSessionChecks(ctx, task.id, check.generation)).toBe(false);
  expect(agentWorkspaceBusy(ctx, repo, 'other-task')).toBe(true);
  await settleAgentSessionChecks({ ...ctx });
  expect(existsSync(join(repo, 'stop-completed'))).toBe(true);
  expect(readTask(ctx, task.id)?.result?.acceptance?.passed).toBe(true);
  expect(agentChecksPending(ctx, task.id)).toBe(false);
}, 15000);

test('legacy checker schema migration holds writer admission across inspection with concurrent stops', async () => {
  const { ctx, task, check } = await fixture();
  const db = taskDatabase(ctx);
  if (db.query<{ name: string }, []>('PRAGMA table_info(agent_session_checks)').all().some(c => c.name === 'cancelled')) db.run('ALTER TABLE agent_session_checks DROP COLUMN cancelled');
  const script = join(ctx.home, 'migration.ts');
  const storeModule = new URL('../src/tasks/store.ts', import.meta.url).href;
  const checksModule = new URL('../src/session/agents-checks.ts', import.meta.url).href;
  const ctxModule = new URL('../src/ctx.ts', import.meta.url).href;
  writeFileSync(script, `
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {makeCtx} from ${JSON.stringify(ctxModule)};
import {taskDatabase} from ${JSON.stringify(storeModule)};
import {stopAgentSessionChecks} from ${JSON.stringify(checksModule)};
const [role,root,task,generation]=Bun.argv.slice(2);
const wait=(name)=>{const end=Date.now()+10000;while(!existsSync(join(root,name))){if(Date.now()>end)throw Error('migration gate deadline');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}};
const ctx=makeCtx({env:process.env});
const db=taskDatabase(ctx),query=db.query.bind(db);
let inspections=0;
db.query=(sql,...args)=>{
  const statement=query(sql,...args);
  if(role==='a'&&sql==='PRAGMA table_info(agent_session_checks)'&&++inspections===2){
    const rows=statement.all();
    writeFileSync(join(root,'inspected'),'ready');
    wait('release-schema');
    return {all:()=>rows};
  }
  return statement;
};
writeFileSync(join(root,role+'-ready'),'ready');wait(role+'-go');
writeFileSync(join(root,role+'-attempt'),'attempt');
await stopAgentSessionChecks(ctx,task,Number(generation));
`);
  const launch = (role: string) => Bun.spawn([process.execPath, script, role, ctx.home, task.id, String(check.generation)], {
    env: { ...process.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome }, stdout: 'pipe', stderr: 'pipe',
  });
  const a = launch('a'), b = launch('b');
  let writerHeld = false;
  try {
    await until(() => existsSync(join(ctx.home, 'a-ready')) && existsSync(join(ctx.home, 'b-ready')));
    writeFileSync(join(ctx.home, 'a-go'), 'go');
    await until(() => existsSync(join(ctx.home, 'inspected')));
    writeFileSync(join(ctx.home, 'b-go'), 'go');
    await until(() => existsSync(join(ctx.home, 'b-attempt')));
    const probe = new Database(join(ctx.pacerHome, 'state', 'tasks.db'));
    try {
      probe.run('PRAGMA busy_timeout=0');
      try { probe.run('BEGIN IMMEDIATE'); probe.run('ROLLBACK'); }
      catch (error) { if (!String(error).includes('locked')) throw error; writerHeld = true; }
    } finally { probe.close(); }
  } finally {
    for (const gate of ['a-go', 'b-go', 'release-schema']) writeFileSync(join(ctx.home, gate), 'release');
    await Promise.all([a.exited, b.exited]);
  }
  expect(await new Response(a.stderr).text()).toBe('');
  expect(await new Response(b.stderr).text()).toBe('');
  expect(a.exitCode).toBe(0);
  expect(b.exitCode).toBe(0);
  expect(writerHeld).toBe(true);
  expect(db.query<{ cancelled: number; generation: number }, [string]>('SELECT cancelled,generation FROM agent_session_checks WHERE task=?').get(task.id)).toEqual({ cancelled: check.generation, generation: check.generation });
}, 20000);
