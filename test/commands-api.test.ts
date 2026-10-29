import { expect, test } from 'bun:test';
import { apiCommand } from '../src/commands/api';
import { ApiError, type ApiClient } from '../src/api/client-types';
import { fakeCtx } from './helpers';
function fixture() {
  const calls: [string, unknown][] = [];
  let closed = 0;
  const client = { kind: 'http', hello: async () => ({ protocol: '3.0.0', ops: ['api.list', 'api.describe', 'runner.settings.get'], events: [], pacer: 'service-version' }),
    call: async (name: string, params: unknown) => { calls.push([name, params]); return { remote: true }; }, close: () => closed++,
  } as unknown as ApiClient;
  return { client, calls, get closed() { return closed; } };
}
test('CLI discovery calls the selected service with compact filters', async () => {
  const f = fixture();
  const result = await apiCommand(['list', '--prefix', 'runner.', '--search', 'settings', '--json'], fakeCtx(), { connect: async () => f.client });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({ result: { remote: true } });
  expect(f.calls).toEqual([['api.list', { prefix: 'runner.', search: 'settings' }]]);
  expect(f.closed).toBe(1);
});
test('CLI uses {} by default and supports bounded stdin/files without quoting', async () => {
  const f = fixture();
  const deps = { connect: async () => f.client, read: async () => '{"enabled":true}' };
  await apiCommand(['call', 'runner.settings.get', '--json'], fakeCtx(), deps);
  await apiCommand(['call', 'runner.settings.get', '--params-file', '-', '--json'], fakeCtx(), deps);
  expect(f.calls).toEqual([['runner.settings.get', {}], ['runner.settings.get', { enabled: true }]]);
});
test('CLI rejects malformed, oversized, conflicting and unknown input before connection', async () => {
  for (const args of [ ['call', 'x', '--params', '[]'], ['call', 'x', '--params', '{secret'], ['call', 'x', '--params', '{}', '--params-file', '-'], ['list', '--params', '{}'], ['call', 'x', '--wat'], ['list', '--json', '--json'], ['call', 'x', '--params', JSON.stringify({ x: 's'.repeat(262144) })] ]) {
    let connected = false;
    const result = await apiCommand([...args, ...(args.includes('--json') ? [] : ['--json'])], fakeCtx(), { connect: async () => { connected = true; throw Error('must not connect'); } });
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(JSON.parse(result.err).error.code).toMatch(/invalid_input|too_large/);
    expect(result.err).not.toContain('{secret');
    expect(connected).toBe(false);
  }
});
test('CLI preserves structured service errors without retry or leaking submitted keys', async () => {
  const f = fixture();
  let calls = 0;
  f.client.call = async () => { calls++; throw new ApiError('conflict', 'Secret credential abc-secret failed', 'recheck abc-secret'); };
  const result = await apiCommand(['call', 'runner.settings.get', '--params', '{"key":"abc-secret"}', '--json'], fakeCtx(), { connect: async () => f.client });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.err).error.code).toBe('conflict');
  expect(result.err).not.toContain('abc-secret');
  expect(calls).toBe(1);
});
test('old service discovery fails with an upgrade hint and no local catalog substitution', async () => {
  const f = fixture();
  f.client.hello = async () => ({ protocol: '3.0.0', pacer: 'old', ops: [], events: [] });
  const result = await apiCommand(['list', '--json'], fakeCtx(), { connect: async () => f.client });
  expect(result.code).not.toBe(0);
  expect(JSON.parse(result.err).error.hint).toContain('upgrade');
  expect(f.calls).toEqual([]);
});

test('generic HTTP calls retain the local executor delegation guard before connecting', async () => {
  for (const [name, params] of [['onboarding.try', {}], ['task.delegate', {}], ['task.retry', {}], ['task.retry_all', {}], ['task.answer', {}], ['task.send', {}], ['session.create', {}], ['session.resume', {}], ['task.review', {verdict: 'send_back'}], ['task.review', {verdict: 'retry'}]] as const) {
    let connected = false;
    const ctx = fakeCtx(); ctx.env.PACER_ROLE = 'executor';
    const result = await apiCommand(['call', name, '--params', JSON.stringify(params), '--json'], ctx, {connect:async()=>{connected=true;return fixture().client;}});
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.err).error.code).toBe('not_allowed');
    expect(connected).toBe(false);
  }
});
