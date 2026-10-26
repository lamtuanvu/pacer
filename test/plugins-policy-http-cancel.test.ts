import { expect, test } from 'bun:test';
import { handleV2 } from '../src/api/http';
import { listTasksWhere } from '../src/tasks/store';
import { policyGateFixture } from './fixtures/policy-host';
import { ReadOwner } from '../src/plugins/read-owner';
import type { PluginManifest } from '../src/plugins/protocol';

async function entered(f: ReturnType<typeof policyGateFixture>) {
  const until = Date.now() + 2000;
  while (!f.calls().length && Date.now() < until) await Bun.sleep(5);
  expect(f.calls().length).toBeGreaterThan(0);
}
function request(repo: string, signal?: AbortSignal) {
  return new Request('http://localhost/v3/ops/task.delegate', { method: 'POST', body: JSON.stringify({ goal: 'owned pending policy fixture', repo }), signal });
}

test('HTTP request abort during an actual policy wait prevents admission and a fresh request can succeed', async () => {
  const f = policyGateFixture({ verdict: 'allow' }, 150), controller = new AbortController();
  const pending = handleV2(request(f.repo, controller.signal), { getCtx: () => f.ctx, opDeps: { spawnRunner: f.spawn } });
  await entered(f); controller.abort();
  const response = await pending;
  expect(response.status).not.toBe(200);
  await Bun.sleep(180);
  expect(listTasksWhere(f.ctx)).toHaveLength(0);
  expect(f.launches()).toBe(0);
  const fresh = await handleV2(request(f.repo), { getCtx: () => f.ctx, opDeps: { spawnRunner: f.spawn } });
  expect(fresh.status).toBe(200);
  expect(listTasksWhere(f.ctx)).toHaveLength(1);
  expect(f.launches()).toBe(1);
});

test('HTTP lifetime composition preserves an upstream trusted abort instead of replacing it', async () => {
  const f = policyGateFixture({ verdict: 'allow' }, 150), parent = new AbortController();
  const pending = handleV2(request(f.repo), { getCtx: () => ({ ...f.ctx, operation: { signal: parent.signal, deadline: Date.now() + 2000 } }), opDeps: { spawnRunner: f.spawn } });
  await entered(f); parent.abort();
  expect((await pending).status).not.toBe(200);
  expect(listTasksWhere(f.ctx)).toHaveLength(0);
  expect(f.launches()).toBe(0);
});

test('retained read owners do not inherit the original request operation lifetime', () => {
  const f = policyGateFixture({ verdict: 'allow' }), controller = new AbortController();
  const manifest: PluginManifest = { id: 'fx-read', version: '1.0.0', publisher: 'test', host: '^1.5', capabilities: [{ name: 'tasks.read' }], contributes: { policy: {} }, reentrant: false, tier: 'free' };
  const owner = new ReadOwner({ ...f.ctx, operation: { signal: controller.signal } }, manifest, ['tasks.read'], () => true);
  controller.abort();
  expect(owner.ctx.operation).toBeUndefined();
  expect(owner.readContext().operation).toBeUndefined();
  expect(() => owner.assertGranted('tasks.read')).not.toThrow();
});

test('detached plugin launch contexts exclude the original request lifetime', async () => {
  const { PluginRegistry } = await import('../src/plugins/registry');
  const { readManifestFile } = await import('../src/plugins/manifest');
  const { registerFixtureCleanup } = await import('./fixture-cleanup');
  const { join } = await import('node:path');
  const f = policyGateFixture({ verdict: 'allow' }), controller = new AbortController();
  const read = readManifestFile(join(f.dir, 'pacer-plugin.json'));
  if (!read.ok) throw Error(read.error);
  let launchCtx: import('../src/types').Ctx | undefined;
  const registry = new PluginRegistry({ bundled: [{ manifest: read.manifest, main: async () => ({ handlers: {} }) }], spawnBundled: ctx => {
    launchCtx = ctx;
    return { argv: [process.execPath, join(f.dir, 'main.ts')], cwd: f.dir, env: { PATH: process.env.PATH } };
  } });
  registerFixtureCleanup(() => registry.shutdown());
  await registry.call({ ...f.ctx, operation: { signal: controller.signal } }, 'fx-policy', 'policy.before', { decision: 'delegate', input: { goal: 'fixture', repo: f.repo, kind: null, requestedExecutor: null, placement: 'auto' } }, { signal: controller.signal });
  expect(launchCtx).toBeDefined();
  expect(launchCtx?.operation).toBeUndefined();
  controller.abort();
  expect(registry.list(f.ctx).find(plugin => plugin.id === 'fx-policy')?.pid).not.toBeNull();
});

test('authenticated real HTTP disconnect cancels pending policy admission without cancelling later work', async () => {
  const { startServer } = await import('../src/serve/http');
  const f = policyGateFixture({ verdict: 'allow' }, 150), controller = new AbortController();
  let launchedOperation: import('../src/types').Ctx['operation'];
  const server = startServer(() => f.ctx, { port: 0, listener: false, pumpMs: 0, opDeps: { spawnRunner: ctx => { launchedOperation = ctx.operation; return f.spawn(); } } });
  const origin = `http://127.0.0.1:${server.port}`;
  const headers = { Authorization: `Bearer ${server.token}`, Origin: origin, 'X-Pacer-Client': 'test/1', 'Content-Type': 'application/json' };
  try {
    const pending = fetch(`${origin}/v3/ops/task.delegate`, { method: 'POST', headers, body: JSON.stringify({ goal: 'owned network policy fixture', repo: f.repo }), signal: controller.signal }).then(response => response.status, error => error.name);
    await entered(f); controller.abort();
    expect(await pending).toBe('AbortError');
    await Bun.sleep(250);
    expect(listTasksWhere(f.ctx)).toHaveLength(0);
    expect(f.launches()).toBe(0);
    const response = await fetch(`${origin}/v3/ops/task.delegate`, { method: 'POST', headers, body: JSON.stringify({ goal: 'owned accepted policy fixture', repo: f.repo }) });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(f.launches()).toBe(1);
    expect(launchedOperation).toBeUndefined();
    expect(listTasksWhere(f.ctx)).toHaveLength(1);
  } finally { await server.stop(); }
});

test('HTTP preserves the trusted outer deadline even when plugin failure mode is open', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = policyGateFixture({ verdict: 'allow' }, 250), controller = new AbortController();
  f.config.plugins.policy.mode = 'open';
  writeFileSync(join(f.ctx.pacerHome, 'strategy.yaml'), JSON.stringify(f.config));
  const deadline = Date.now() + 100;
  const response = await handleV2(request(f.repo), { getCtx: () => ({ ...f.ctx, operation: { signal: controller.signal, deadline } }), opDeps: { spawnRunner: f.spawn } });
  expect(response.status).not.toBe(200);
  expect(listTasksWhere(f.ctx)).toHaveLength(0);
  expect(f.launches()).toBe(0);
});
