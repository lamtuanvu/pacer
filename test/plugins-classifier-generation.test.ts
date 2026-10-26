import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED } from '../plugins/bundled';
import { PluginRegistry } from '../src/plugins/registry';
import { validateClassifier } from '../src/config/classifier';
import type { CallAuthority } from '../src/plugins/authority';
import { fakeCtx } from './helpers';
import {fixtureConsent} from './fixtures/plugin-consent';

const roots: string[] = [];
const registries: PluginRegistry[] = [];
const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map(r => r.shutdown()));
  await Promise.all(servers.splice(0).map(s => s.stop(true)));
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(slowHello = false) {
  const spawned = { count: 0 };
  const root = mkdtempSync(join(tmpdir(), 'pacer-classifier-generation-'));
  roots.push(root);
  const ctx = fakeCtx({ home: root, pacerHome: join(root, '.pacer') });
  ctx.readOnly = true;
  mkdirSync(ctx.pacerHome);
  const canonical = BUNDLED.find(b => b.manifest.id === 'pacer-classify')!;
  const registry = new PluginRegistry({
    bundled: [canonical],
    spawnBundled: () => {
      spawned.count++;
      return {
        argv: [process.execPath, join(import.meta.dir, 'fixtures/classifier-generation/peer.ts'), ...(slowHello ? ['--slow-hello'] : [])],
        cwd: root, env: {},
      };
    },
  });
  registries.push(registry);
  return { ctx, registry, canonical, spawned };
}
function cfg(baseUrl: string) {
  return validateClassifier({ adapters: {
    ollama: { base_url: baseUrl, model: 'owned-model', key_env: 'OWNED_KEY' },
    jev: { base_url: 'https://jev.invalid' },
  } }, {});
}
function write(ctx: ReturnType<typeof fakeCtx>, baseUrl: string) {
  writeFileSync(join(ctx.pacerHome, 'strategy.yaml'), `planner: claude-code
providers:
  claude-code: {}
classifier:
  adapters:
    ollama:
      base_url: ${baseUrl}
      model: owned-model
      key_env: OWNED_KEY
    jev:
      base_url: https://jev.invalid
`);
}
const question = { type: 'yesno', id: 'owned', instructions: 'owned' };
async function ask(f: ReturnType<typeof fixture>, snapshot: ReturnType<typeof cfg>, state: unknown = {}, config: unknown = { forged: 'C' }) {
  return f.registry.call<any>(f.ctx, 'pacer-classify', 'classifier.ask', {
    adapter: 'ollama', state: JSON.stringify(state), question, timeoutMs: 4000, config,
  }, { deadlineMs: 5000, classifierConfig: snapshot });
}

test('canonical hello/list/config.get/selected request share captured validated projection', async () => {
  const f = fixture();
  write(f.ctx, 'http://localhost:1234/v1');
  const original = JSON.stringify(f.canonical.manifest);
  const info = f.registry.list(f.ctx).find(p => p.id === 'pacer-classify')!;
  expect(info.capabilities.find(c => c.name === 'net.http')!.scopes).toEqual(['localhost', 'jev.invalid']);
  const snapshot = cfg('http://localhost:1234/v1');
  const pending = ask(f, snapshot);
  snapshot.adapters.ollama.model = 'mutated-after-admission';
  const result = JSON.parse((await pending).value);
  expect(result.hello).toEqual(result.config);
  expect(result.selected).toEqual(result.config.adapters.ollama);
  expect(result.selected.keyRef).toBe('secrets:OWNED_KEY');
  expect(result.selected.model).toBe('owned-model');
  expect(JSON.stringify(f.canonical.manifest)).toBe(original);
});

test('A to B cancels old authority before replacement, preserves captured scopes and rejects forged C', async () => {
  let admitted!: () => void;
  const reached = new Promise<void>(resolve => { admitted = resolve; });
  let effects = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    effects++;
    if (new URL(request.url).pathname === '/slow') { admitted(); await Bun.sleep(100); }
    return new Response('owned');
  } });
  servers.push(server);
  const f = fixture(), a = `http://localhost:${server.port}`, b = `http://127.0.0.1:${server.port}`;
  write(f.ctx, a);
  f.registry.list(f.ctx);
  const old = ask(f, cfg(a), { url: a + '/slow' });
  const oldResult = old.then(() => ({ success: true }), error => ({ code: error.code }));
  await Promise.race([reached, oldResult.then(() => { throw Error('old request settled before reaching owned server'); })]);
  const entry = (f.registry as unknown as { entries: Map<string, { authorities: Map<string, CallAuthority> }> }).entries.get('pacer-classify')!;
  const oldAuthority = [...entry.authorities.values()][0]!;
  let cleanupEntered!: () => void, releaseCleanup!: () => void;
  const entered = new Promise<void>(resolve => { cleanupEntered = resolve; });
  const released = new Promise<void>(resolve => { releaseCleanup = resolve; });
  oldAuthority.onRevoke(async () => { cleanupEntered(); await released; });
  write(f.ctx, b);
  f.registry.refresh(f.ctx);
  const replacement = ask(f, cfg(b), { url: b });
  try {
    await entered;
    expect(oldAuthority.signal.aborted).toBe(true);
    expect(oldAuthority.resources.http!.hosts).toEqual(['localhost']);
    expect(f.spawned.count).toBe(1);
    expect(effects).toBe(1);
  } finally { releaseCleanup(); }
  const current = JSON.parse((await replacement).value);
  expect(await oldResult).toHaveProperty('code');
  expect(current.selected.baseUrl).toBe(b);
  expect(current.config).toEqual(current.hello);
  expect(current.response.body).toBe('owned');
  await expect(ask(f, cfg(b), { url: `http://127.0.0.2:${server.port}` })).rejects.toMatchObject({ code: 'capability_denied' });
  expect(effects).toBe(2);
});

test('missing strategy uses defaults but explicit captured config wins; malformed strategy still surfaces', async () => {
  const f = fixture();
  const info = f.registry.list(f.ctx).find(p => p.id === 'pacer-classify')!;
  expect(info.capabilities.find(c => c.name === 'net.http')!.scopes).toEqual(['127.0.0.1', 'api.typesafe.ai']);
  const result = JSON.parse((await ask(f, cfg('https://owned.invalid/v1'))).value);
  expect(result.selected.baseUrl).toBe('https://owned.invalid/v1');
  writeFileSync(join(f.ctx.pacerHome, 'strategy.yaml'), 'classifier: [not-a-mapping]\n');
  expect(() => f.registry.refresh(f.ctx)).toThrow();
});

test('overlapping cold starts share a generation and changed hello waits for retirement', async () => {
  const f = fixture(true), a = 'https://a.invalid/v1', b = 'https://b.invalid/v1';
  write(f.ctx, a);
  const first = ask(f, cfg(a)).then(value => ({ value }), error => ({ code: error.code }));
  while (f.spawned.count === 0) await Bun.sleep(1);
  const current = JSON.parse((await ask(f, cfg(b))).value);
  expect(await first).toHaveProperty('code');
  expect(current.selected.baseUrl).toBe(b);
  expect(f.spawned.count).toBe(2);
  const together = await Promise.all([ask(f, cfg(b)), ask(f, cfg(b))]);
  expect(together.map(result => JSON.parse(result.value).pid)).toEqual([current.pid, current.pid]);
  expect(f.spawned.count).toBe(2);
});

test('installed same-id plugin never acquires canonical snapshot projection', async () => {
  const f = fixture(), dir = join(f.ctx.pacerHome, 'plugins/pacer-classify');
  mkdirSync(dir, { recursive: true });
  const installed = { ...structuredClone(f.canonical.manifest), entry: 'main' };
  writeFileSync(join(dir, 'pacer-plugin.json'), JSON.stringify(installed));
  writeFileSync(join(dir, 'main'), `#!${process.execPath}\nimport ${JSON.stringify(join(import.meta.dir, 'fixtures/classifier-generation/peer.ts'))};\n`, { mode: 0o700 });
  writeFileSync(join(f.ctx.pacerHome, 'strategy.yaml'), `planner: claude-code
providers:
  claude-code: {}
plugins:
  installed:
    pacer-classify:
      version: 0.2.0
      capabilities: [net.http, secrets.resolve, config.get, log]
      consent: ${fixtureConsent(installed)}
  config:
    pacer-classify:
      genericOwned: true
`);
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error('not bundled'); } });
  registries.push(registry);
  const response: any = await registry.call(f.ctx, 'pacer-classify', 'classifier.ask', {
    adapter: 'ollama', state: '{}', question, timeoutMs: 1000, config: { forged: 'C' },
  }, { deadlineMs: 3000, classifierConfig: cfg('https://not-canonical.invalid') });
  const result = JSON.parse(response.value);
  expect(result.config).toEqual({ genericOwned: true });
  expect(result.hello).toEqual(result.config);
  expect(result.selected).toEqual({ forged: 'C' });
});

test('bundled same-id lookalike is not the canonical reference', async () => {
  const f = fixture();
  write(f.ctx, 'https://owned.invalid');
  const lookalike = { manifest: structuredClone(f.canonical.manifest), main: f.canonical.main };
  const registry = new PluginRegistry({ bundled: [lookalike], spawnBundled: () => ({
    argv: [process.execPath, join(import.meta.dir, 'fixtures/classifier-generation/peer.ts')], cwd: f.ctx.home, env: {},
  }) });
  registries.push(registry);
  const response: any = await registry.call(f.ctx, 'pacer-classify', 'classifier.ask', {
    adapter: 'ollama', state: '{}', question, timeoutMs: 1000, config: { untouched: true },
  }, { deadlineMs: 3000, classifierConfig: cfg('https://ignored.invalid') });
  const result = JSON.parse(response.value);
  expect(result.selected).toEqual({ untouched: true });
  expect(result.config).toEqual({});
  expect(registry.list(f.ctx)[0]!.capabilities.find(c => c.name === 'net.http')!.scopes)
    .toEqual(f.canonical.manifest.capabilities!.find(c => c.name === 'net.http')!.scopes);
});
