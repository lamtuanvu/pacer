import { expect, test } from 'bun:test';
import { refusal } from '../scripts/live/guard';
import { BLOCKED_OPS } from '../scripts/live/proxy';
import { connectClient } from '../src/api/client';
import { fakeCtx } from './helpers';
test('generic calls retain D3/D8 refusal policy without inspecting payloads', () => {
  for (const op of Object.keys(BLOCKED_OPS).filter(op => !op.includes('*'))) {
    expect(refusal(['api', 'call', op, '--params-file', '-', '--json'])).toContain('D3');
  }
  expect(refusal(['api', 'call', 'desktop.update.restart'])).toContain('D3');
  expect(refusal(['api', 'call', 'service.status'])).toBeUndefined();
  expect(refusal(['api', 'list', '--json'])).toBeUndefined();
});
test('selected service cannot fall back when forced local or unavailable', async () => {
  const ctx = fakeCtx();
  ctx.env = { PACER_API: 'inprocess' };
  await expect(connectClient(ctx, { protocol: 3, allowFallback: false })).rejects.toMatchObject({ code: 'not_allowed' });
  ctx.env = {};
  await expect(connectClient(ctx, { protocol: 3, allowFallback: false })).rejects.toMatchObject({ code: 'not_allowed' });
});

test('inline config.set params pass D3 only under the D8 body rule', () => {
  expect(refusal(['api', 'call', 'config.set', '--params', '{"key":"execution.backend","value":"direct"}', '--json'])).toBeUndefined();
  expect(refusal(['api', 'call', '--params', '{"key":"planner","value":"codex","integrations":"skip"}', 'config.set'])).toBeUndefined();
  for (const args of [
    ['api', 'call', 'config.set', '--params', '{"key":"planner","value":"codex","integrations":"install"}'],
    ['api', 'call', 'config.set', '--params', '{"key":"planner","value":"codex"}'],
    ['api', 'call', 'config.set', '--params', 'not json'],
    ['api', 'call', 'config.set', '--params-file', '-'],
    ['api', 'call', 'config.set', '--params', '{"key":"pacing.policy","value":"even"}', '--params-file', '-'],
    ['api', 'call', 'config.set', '--params', '{"key":"pacing.policy","value":"even"}', '--params', '{"key":"planner","value":"codex","integrations":"install"}'],
    ['api', 'call', 'config.set'],
    ['api', 'call', 'agent.connect', '--params', '{"key":"pacing.policy","value":"even"}'],
  ]) expect(refusal(args), args.join(' ')).toContain('D3');
});

test('generic guard identifies operations after flags without reading stdin payloads', () => {
  expect(refusal(['api','call','--params-file','-','--json','service.install'])).toContain('D3');
  expect(refusal(['api','call','--params','{}','account.add','--json'])).toContain('D3');
});
