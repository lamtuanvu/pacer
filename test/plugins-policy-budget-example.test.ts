import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObservationClient, PolicyTask } from '@pacer/plugin';
import { createBudgetPolicy } from '../plugins/examples/pacer-policy-budget/budget';
import { BUNDLED } from '../plugins/bundled';
import { readManifestFile } from '../src/plugins/manifest';
import {fixtureConsent} from './fixtures/plugin-consent';

function fixture(config: Record<string, unknown> = {}, count = 0) {
  let running = count;
  const lists: unknown[] = [], subscriptions: unknown[] = [], messages: string[] = [];
  const host: ObservationClient = {
    config: async () => config,
    tasks: {
      read: async () => { throw Error('example must use bounded state-filtered list'); },
      list: async options => { lists.push(options); return Array.from({ length: Math.min(running, options?.limit ?? 500) }, (_, i) => ({ id: `task-${i}`, state: 'running' }) as PolicyTask); },
    },
    events: { subscribe: async types => { subscriptions.push(types); } },
    log: async (_level, message) => { messages.push(message); },
  };
  return { host, lists, subscriptions, messages, setRunning: (n: number) => { running = n; } };
}
const decision = { decision: 'delegate', input: { goal: 'fixture', repo: '/fixture', kind: null, requestedExecutor: null, placement: 'auto' } };
const signal = () => new AbortController().signal;

test('budget example is unbundled and declares only its four read capabilities', () => {
  const path = join(import.meta.dir, '../plugins/examples/pacer-policy-budget/pacer-plugin.json');
  expect(readManifestFile(path).ok).toBe(true);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  expect(manifest.capabilities.map((c: { name: string }) => c.name).sort()).toEqual(['config.get', 'events.subscribe', 'log', 'tasks.read']);
  expect(BUNDLED.some(plugin => plugin.manifest.id === manifest.id)).toBe(false);
});

test('default limit3 vetoes at threshold and subscribes only after an owned method', async () => {
  const policy = createBudgetPolicy(), f = fixture({}, 2);
  expect(f.subscriptions).toHaveLength(0);
  expect(await policy.handlers['policy.before']!(decision, f.host, signal())).toEqual({ verdict: 'allow' });
  f.setRunning(3);
  expect(await policy.handlers['policy.before']!(decision, f.host, signal())).toMatchObject({ verdict: 'veto' });
  expect(f.lists).toEqual([{ states: ['running'], limit: 3 }, { states: ['running'], limit: 3 }]);
  expect(f.subscriptions).toEqual([['task', 'activity', 'reset']]);
});

test('configured limit governs delegate only; route and review remain allowed', async () => {
  const policy = createBudgetPolicy(), f = fixture({ N: 2 }, 2);
  expect(await policy.handlers['policy.before']!(decision, f.host, signal())).toMatchObject({ verdict: 'veto' });
  expect(await policy.handlers['policy.before']!({ decision: 'route', input: { taskId: 't-20261026-010203-abcd', candidates: ['codex'] } }, f.host, signal())).toEqual({ verdict: 'allow' });
  expect(await policy.handlers['policy.before']!({ decision: 'review', input: { taskId: 't-20261026-010203-abcd', revision: 1, state: 'done', verdict: 'accept' } }, f.host, signal())).toEqual({ verdict: 'allow' });
  expect(f.lists).toHaveLength(1);
});

test('reset resubscribes and resnapshots; admission always reads fresh rather than cached counts', async () => {
  const policy = createBudgetPolicy(), f = fixture({}, 0);
  expect(await policy.handlers['diagnostic.ping']!({}, f.host, signal())).toMatchObject({ ok: true, uptimeS: expect.any(Number) });
  f.setRunning(1);
  await policy.onEvent({ seq: 2, at: 1, type: 'reset', data: { reason: 'resnapshot' } }, f.host);
  expect(f.subscriptions).toHaveLength(2);
  f.setRunning(3);
  expect(await policy.handlers['policy.before']!(decision, f.host, signal())).toMatchObject({ verdict: 'veto' });
  expect(f.messages.every(message => !message.includes('fixture'))).toBe(true);
});

for (const N of [null, 0, -1, 1.5, '3', 501]) test(`budget example rejects unsupported bounded limit ${JSON.stringify(N)}`, async () => {
  const policy = createBudgetPolicy(), f = fixture({ N });
  await expect(policy.handlers['policy.before']!(decision, f.host, signal())).rejects.toThrow('N must be an integer from 1 to 500');
  expect(f.lists).toHaveLength(0);
});

test('already cancelled checks perform no host requests', async () => {
  const policy = createBudgetPolicy(), f = fixture(), controller = new AbortController(); controller.abort();
  await expect(policy.handlers['policy.before']!(decision, f.host, controller.signal)).rejects.toThrow('cancelled');
  expect(f.lists).toHaveLength(0); expect(f.subscriptions).toHaveLength(0);
});

test('built unbundled example uses actual negotiated host reads and vetoes at its configured limit', async () => {
  const { mkdirSync, chmodSync, copyFileSync, writeFileSync } = await import('node:fs');
  const { fakeCtx } = await import('./helpers');
  const { registerFixtureCleanup } = await import('./fixture-cleanup');
  const { pluginRegistry, shutdownPlugins } = await import('../src/plugins');
  const { createTask, updateTask } = await import('../src/tasks/store');
  const ctx = fakeCtx({ env: { PATH: process.env.PATH }, which: () => null });
  const pacerHome = ctx.pacerHome;
  registerFixtureCleanup(() => shutdownPlugins({ pacerHome }));
  const folder = join(pacerHome, 'plugins/pacer-policy-budget');
  mkdirSync(join(folder, 'dist'), { recursive: true });
  const entry = join(folder, 'dist/main.js');
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, '../plugins/examples/pacer-policy-budget/index.ts')], target: 'bun', outdir: join(folder, 'dist'), naming: 'main.js' });
  expect(build.success, build.logs.map(String).join('\n')).toBe(true);
  expect(readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env bun\n')).toBe(true);
  chmodSync(entry, 0o755);
  copyFileSync(join(import.meta.dir, '../plugins/examples/pacer-policy-budget/pacer-plugin.json'), join(folder, 'pacer-plugin.json'));
  const consent=fixtureConsent(JSON.parse(readFileSync(join(folder,'pacer-plugin.json'),'utf8')));
  writeFileSync(join(pacerHome, 'strategy.yaml'), JSON.stringify({ planner: 'codex', accounts: { codex: { kind: 'codex', usage: 'quota' } }, routing: [{ default: ['codex'] }], plugins: { installed: { 'pacer-policy-budget': { version: '0.1.0', capabilities: ['tasks.read', 'events.subscribe', 'config.get', 'log'], consent } }, config: { 'pacer-policy-budget': { N: 2 } } } }));
  const registry = pluginRegistry(ctx, { bundled: [], spawnBundled: () => { throw Error('example must remain unbundled'); } });
  const reports = await registry.doctor(ctx, 'pacer-policy-budget');
  expect(reports).toHaveLength(1);
  expect(reports[0]?.ok, JSON.stringify(reports)).toBe(true);
  const before = await registry.call(ctx, 'pacer-policy-budget', 'policy.before', decision);
  expect(before).toMatchObject({ verdict: 'allow' });
  const tasks = [];
  for (let i = 0; i < 2; i++) {
    const task = createTask(ctx, { brief: { goal: `owned example fixture ${i}`, repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    tasks.push(updateTask(ctx, task.id, current => { current.state = 'running'; current.runnerPid = process.pid; }));
  }
  expect(await registry.call(ctx, 'pacer-policy-budget', 'policy.before', decision)).toMatchObject({ verdict: 'veto', reason: 'Running task limit reached (2).' });
  const { publish } = await import('../src/link/publish');
  const { taskData } = await import('../src/link/pump');
  await publish(ctx, [{ type: 'task', data: taskData(tasks[0]!) }]);
  const log = join(pacerHome, 'logs/plugins/pacer-policy-budget.log'), until = Date.now() + 2000;
  let output = '';
  while (Date.now() < until) {
    try { output = readFileSync(log, 'utf8'); } catch { /* The owned logger has not created the file yet. */ }
    if (output.includes('Budget policy observation: 2 running observed; limit 2.')) break;
    await Bun.sleep(10);
  }
  expect(output).toContain('Budget policy observation: 2 running observed; limit 2.');
  expect(output).not.toContain('owned example fixture');
});
