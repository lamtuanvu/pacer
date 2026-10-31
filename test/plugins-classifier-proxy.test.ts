import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAdapters } from '../src/classify/registry';
import { validateClassifier } from '../src/config/classifier';
import { QUESTIONS } from '../src/classify/state';
import { shutdownPlugins } from '../src/plugins';
import { fakeCtx } from './helpers';
const contexts: ReturnType<typeof fakeCtx>[] = [];
afterEach(async () => { await Promise.all(contexts.splice(0).map(shutdownPlugins)); });
test('disabled classifier plugin has no built-in rules fallback', async () => {
  const ctx = fakeCtx(); contexts.push(ctx);
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, 'strategy.yaml'), 'planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  disabled: [pacer-classify]\n');
  const adapters = buildAdapters(ctx, validateClassifier(undefined, {}), 3000);
  await expect(adapters.rules.ask('{}', QUESTIONS.task_kind)).rejects.toMatchObject({ code: 'plugin_unavailable' });
});
test('rules proxy returns the actual bundled plugin answer', async () => {
  const ctx = fakeCtx(); contexts.push(ctx);
  const adapters = buildAdapters(ctx, validateClassifier(undefined, {}), 3000);
  expect(await adapters.rules.ask('{}', QUESTIONS.task_kind)).toMatchObject({ latencyMs: 0, costUsd: 0 });
});

test('large finite classifier budget survives actual child startup', async () => {
  const ctx = fakeCtx(); contexts.push(ctx);
  const adapters = buildAdapters(ctx, validateClassifier(undefined, {}), 9e15);
  expect(await adapters.rules.ask('{}', QUESTIONS.task_kind)).toMatchObject({ latencyMs: 0, costUsd: 0 });
});

test('host-owned alias resolves an unusual key name through the actual classifier child', async () => {
  let authorization: string | null = null;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    authorization = request.headers.get('authorization');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ answer: true, confidence: 1 }) } }] });
  } });
  const ctx = fakeCtx({ env: { 'A/B': 'owned-alias-fixture' } }); contexts.push(ctx);
  const cfg = validateClassifier({ adapters: { ollama: { base_url: server.url.href, key_env: 'A/B' } } }, {});
  try {
    expect(await buildAdapters(ctx, cfg, 3000).ollama.ask('{}', { type: 'yesno', id: 'check', instructions: 'answer' })).toMatchObject({ value: true, confidence: 1 });
    expect(String(authorization)).toBe('Bearer owned-alias-fixture');
  } finally { await shutdownPlugins(ctx); await server.stop(true); }
});

test('network requests retain the declared 120000ms capability limit without silently clamping', async () => {
  let effects = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { effects++; return new Response('unexpected'); } });
  const ctx = fakeCtx(); contexts.push(ctx);
  const cfg = validateClassifier({ timeout_ms: 120001, adapters: { ollama: { base_url: server.url.href } } }, {});
  try {
    await expect(buildAdapters(ctx, cfg, cfg.timeoutMs).ollama.ask('{}', { type: 'yesno', id: 'check', instructions: 'answer' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(effects).toBe(0);
  } finally { await shutdownPlugins(ctx); await server.stop(true); }
});
