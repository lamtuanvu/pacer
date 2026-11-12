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

test('config set planner is refused because the CLI installs integrations in-process', () => {
  for (const args of [
    ['config', 'set', 'planner', 'codex'],
    ['config', 'set', 'planner', 'codex#team', '--json'],
    ['config', 'set', '--json', 'planner', 'codex'],
    ['config', 'set', 'planner=codex'],
    ['config', 'set', 'Planner', 'codex'],
    ['config', 'set', ' planner ', 'codex'],
    ['config', 'set', '--planner', 'codex'],
    ['config', 'set', '--', 'planner', 'codex'],
    ['config', '--', 'set', 'planner', 'codex'],
    ['--', 'config', 'set', 'planner', 'codex'],
    ['config', 'set', 'planner'],
  ]) expect(refusal(args), args.join(' ')).toBe('D3: config set planner installs planner integrations in-process, bypassing D8');
  for (const args of [
    ['config', 'set', 'pacing.policy', 'even'],
    ['config', 'set', 'execution.backend', 'direct'],
    ['config', 'get', 'planner'],
    ['config', 'get', '--json'],
  ]) expect(refusal(args), args.join(' ')).toBeUndefined();
});

const HOST_CLI_FORMS: [string[], string][] = [
  [['host', 'add', 'box', '--ssh', 'box.example'], 'host.add'],
  [['host', 'account', 'add', 'box', 'team', '--home', '/abs'], 'host.account.add'],
  [['host', 'repo', 'map', 'box', 'github.com/o/r', '/abs/repo'], 'host.repo.map'],
  [['host', 'repo', 'setup', 'box'], 'host.repo.setup'],
  [['host', 'setup', 'box'], 'host.repo.setup'],
  [['host', 'clean', 'box'], 'host.clean'],
  [['host', 'clean', 'box', '--json'], 'host.clean'],
  [['host', 'terminal', 'box'], 'host.terminal'],
];
for (const [args, op] of HOST_CLI_FORMS) {
  test(`D3 refuses the CLI form ${args.join(' ')} like D8 refuses ${op}`, () => {
    expect(BLOCKED_OPS[op]).toBeDefined();
    expect(refusal(args)).toMatch(new RegExp(`^D3: host .* changes the real user environment \\(D8 refuses ${op.replaceAll('.', '\\.')}\\)$`));
  });
}
test('every D8-refused host operation has a refused CLI form', () => {
  const covered = new Set(HOST_CLI_FORMS.map(([, op]) => op));
  expect(Object.keys(BLOCKED_OPS).filter(op => op.startsWith('host.')).filter(op => !covered.has(op))).toEqual([]);
});
test('host forms are found after flags and flag values the CLI parses anywhere', () => {
  expect(refusal(['host', '--json', 'clean', 'box'])).toContain('D8 refuses host.clean');
  expect(refusal(['host', '--repo', '/abs', 'clean', 'box'])).toContain('D8 refuses host.clean');
  expect(refusal(['host', '--json', 'account', 'add', 'box', 'team'])).toContain('D8 refuses host.account.add');
});
test('host repo admits only list and check, found after flags and flag values', () => {
  for (const args of [
    ['host', 'repo', '--repo', '/abs', 'map', 'box', 'github.com/o/r', '/abs/repo'],
    ['host', 'repo', 'x', 'map'],
    ['host', '--json', 'repo', 'map', 'box'],
    ['host', 'repo', 'map', 'box', '--json'],
    ['host', 'repo', '--', 'map', 'box'],
    ['host', '--', 'repo', 'map'],
    ['host', 'repo', '--repo', 'map', 'list'],
    ['host', 'repo', '--force', '--repo', 'list', 'map', 'box'],
  ]) expect(refusal(args)).toContain('D8 refuses host.repo.map');
  for (const args of [
    ['host', 'repo'],
    ['host', 'repo', 'unmap', 'box'],
    ['host', 'repo', 'remove', '--json'],
    ['host', 'repo', '--repo', 'list', 'unmap'],
    ['host', 'repo', '--force', 'unmap', 'list'],
    ['host', 'repo', '--json=1', 'list'],
    ['host', 'repo', '-x', 'list'],
    ['host', 'repo', '--', 'list'],
    ['host', 'check', 'box', '--repo', 'repo'],
  ]) expect(refusal(args)).toMatch(/^D3: host /);
  for (const args of [
    ['host', 'repo', 'list'],
    ['host', 'repo', 'list', '--json'],
    ['host', 'repo', '--json', 'check', 'box'],
    ['host', 'repo', 'check', 'box', '--repo', '~/repo', '--json'],
    ['host', '--json', 'repo', 'list'],
  ]) expect(refusal(args)).toBeUndefined();
});
test('read-only host forms stay allowed', () => {
  for (const args of [['host', 'list'], ['host', 'list', '--json'], ['host', 'check', 'fakehost', '--json'], ['host', 'check', 'box', '--repo', '~/repo'], ['host']]) {
    expect(refusal(args)).toBeUndefined();
  }
});

test('generic guard identifies operations after flags without reading stdin payloads', () => {
  expect(refusal(['api','call','--params-file','-','--json','service.install'])).toContain('D3');
  expect(refusal(['api','call','--params','{}','account.add','--json'])).toContain('D3');
});
