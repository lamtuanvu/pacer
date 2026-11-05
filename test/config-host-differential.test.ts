import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { StrategyDoc } from '../src/config/edit';
import { canonical, repoKey } from '../src/config/hosts';
import { validateStrategy } from '../src/config/strategy';

type Case = Record<string, unknown>;
const root = join(import.meta.dir, '..');
const before = '# keep comment\nplanner: codex\nproviders: {codex: {}}\nhosts:\n  devbox: {ssh: devbox, repos: {}}\n';
const next = (() => { let state = 0x2381; return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0); })();

function hostBinary() {
  execFileSync('cargo', ['build', '-q', '-p', 'pacer-config', '--example', 'host_diff', '--locked'], { cwd: root });
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--locked', '--format-version', '1'], { cwd: root }).toString());
  return join(metadata.target_directory, 'debug/examples/host_diff');
}

test('seeded host identity and YAML bytes match Rust', async () => {
  const cases: Case[] = [];
  const expected: unknown[] = [];
  for (let i = 0; i < 80; i++) {
    const owner = `team${next() % 1000}`;
    const repo = `api${next() % 1000}`;
    const url = i % 3 === 0 ? `git@GitHub.com:${owner}/${repo}.git` :
      i % 3 === 1 ? `https://github.com/${owner}/${repo}.git` : `ssh://git@github.com/${owner}/${repo}`;
    cases.push({ op: 'key', url });
    expected.push({ key: repoKey(url) });
    const key = `GitHub.com/${owner}/${repo}`;
    const path = `~/src/${repo}`;
    const doc = new StrategyDoc(before);
    doc.setIn(['hosts', 'devbox', 'repos', key.toLowerCase()], path);
    cases.push({ op: 'map', before, alias: 'devbox', key, path });
    expected.push({ after: doc.toString() });
  }
  for (const url of [
    'file:///tmp/repo', 'https://github.com/acme/api?x=1',
    'https://github.com/acme/api#branch', 'git@host:one',
    'git@host:acme/repo.git/', 'https://user:secret@host/acme/repo',
    'git@host:acme/repo extra', 'https://host/acme/repo/extra',
    'https://.host/owner/repo', 'https://host/.owner/repo',
    'https://host//owner/repo', 'u\u00a0x@host:owner/repo',
    'git@host:.owner/.repo', 'git@host:owner/repo',
    'ssh://git@host//owner/repo', 'https://HOST/Owner/Repo.git',
    'https://host/owner/repo%2Fextra', 'https://host:443/owner/repo',
  ]) {
    cases.push({ op: 'key', url });
    expected.push({ key: repoKey(url) });
  }
  for (const [op, fields] of [
    ['add', { alias: 'new-host', ssh: 'build' }],
    ['set', { alias: 'devbox', maxTasks: 4, paused: true, session: 'full' }],
    ['remove', { alias: 'devbox' }],
  ] as const) {
    const doc = new StrategyDoc(before);
    if (op === 'add') doc.setIn(['hosts', fields.alias], { ssh: fields.ssh });
    if (op === 'set') {
      doc.setIn(['hosts', fields.alias, 'max_tasks'], fields.maxTasks);
      doc.setIn(['hosts', fields.alias, 'session'], fields.session);
      doc.setIn(['hosts', fields.alias, 'paused'], fields.paused);
    }
    if (op === 'remove') doc.deleteIn(['hosts', fields.alias]);
    cases.push({ op, before, ...fields });
    expected.push({ after: doc.toString() });
  }
  const refusalCases: Case[] = [
    { op: 'add', alias: 'devbox', ssh: 'other' },
    { op: 'add', alias: 'local', ssh: 'other' },
    { op: 'add', alias: 'new-host', ssh: '-bad' },
    { op: 'add', alias: 'new-host', ssh: 'bad alias' },
    { op: 'remove', alias: 'unknown' },
    { op: 'remove', alias: 'devbox', before: `${before}runners: {remote: {host: devbox, agent: codex, account: codex}}\n` },
    { op: 'set', alias: 'unknown', paused: true },
    { op: 'set', alias: 'devbox', session: 'invalid' },
    ...[0, -1, 17, 1.5, 1.0, 1e2].map(maxTasks => ({ op: 'set', alias: 'devbox', maxTasks })),
    { op: 'map', alias: 'unknown', key: 'host/owner/repo', path: '/src' },
    { op: 'map', alias: 'devbox', key: 'host/owner/repo.git', path: '/src' },
    { op: 'map', alias: 'devbox', key: 'host/owner/repo', path: '   ' },
  ];
  for (const item of refusalCases) {
    const source = typeof item.before === 'string' ? item.before : before;
    const alias = String(item.alias);
    let rejected = false;
    let after = source;
    try {
      const raw = Bun.YAML.parse(source) as Record<string, any>;
      const hosts = raw.hosts as Record<string, unknown>;
      if (item.op === 'add') {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(alias) || alias === 'local' || Object.hasOwn(hosts, alias)) throw Error('alias');
      } else if (item.op === 'remove') {
        if (alias === 'local' || !Object.hasOwn(hosts, alias) ||
          Object.values(raw.runners ?? {}).some((r: any) => r.host === alias)) throw Error('remove');
      } else if (!Object.hasOwn(hosts, alias)) throw Error('unknown');
      const doc = new StrategyDoc(source);
      if (item.op === 'add') doc.setIn(['hosts', alias], { ssh: item.ssh });
      if (item.op === 'remove') doc.deleteIn(['hosts', alias]);
      if (item.op === 'map') {
        const key = String(item.key).toLowerCase();
        if (!canonical(key)) throw Error('key');
        doc.setIn(['hosts', alias, 'repos', key], item.path);
      }
      if (item.op === 'set') {
        if (item.maxTasks !== undefined) doc.setIn(['hosts', alias, 'max_tasks'], item.maxTasks);
        if (item.session !== undefined) doc.setIn(['hosts', alias, 'session'], item.session);
        if (item.paused !== undefined) doc.setIn(['hosts', alias, 'paused'], item.paused);
      }
      after = doc.toString();
      validateStrategy(Bun.YAML.parse(after), 'strategy.yaml');
    } catch { rejected = true; }
    cases.push({ before: source, ...item });
    expected.push(rejected ? { rejected: true, unchanged: source } : { after });
  }
  const numericFields = [
    ['hosts.devbox.max_tasks', [1, 1.0, 1e2, 0, 17, 1.5]],
    ['task_retention_days', [0, 1, 1.0, 1e2, 1.5, 9007199254740991, 9007199254740992]],
    ['execution.local_max_tasks', [1, 1.0, 1e2, 0, 1.5, 9007199254740991, 9007199254740992]],
    ['pacing.fill_threshold', [50, 50.5, 100, 101]],
    ['execution.idle_after_min', [1, 1.0, 1e2, 0, 1441, 1.5]],
    ['execution.session_log_mb', [1, 1.0, 1e2, 0, 257, 1.5]],
    ['execution.session_retention_days', [1, 1.0, 1e2, 0, 3651, 1.5]],
    ['dispatch.timeoutMs', [1, 1.0, 1e2, 0, 10001, 1.5]],
    ['dispatch.learning.minSamples', [20, 20.0, 1e2, 19, 1001, 20.5]],
    ['dispatch.learning.maxAgeDays', [1, 1.0, 1e2, 0, 366, 1.5]],
    ['messaging.keep_worktree_days', [0, 1.0, 1e2, -1, 3651, 1.5]],
    ['messaging.message.max_bytes', [1, 1.0, 1e2, 0, 1048577, 1.5]],
    ['messaging.tree.max_turns', [1, 1.0, 1e2, 0, 10001, 1.5]],
    ['messaging.liveness.interval_s', [10, 10.0, 1e2, 9, 10.5]],
    ['messaging.liveness.max_nudges', [0, 1.0, 1e2, -1, 1.5]],
  ] as const;
  for (const [field, values] of numericFields) for (const value of values) {
    const raw = Bun.YAML.parse(before) as Record<string, any>;
    const path = field.split('.');
    let target = raw;
    for (const part of path.slice(0, -1)) target = target[part] ??= {};
    target[path.at(-1)!] = value;
    let valid = true;
    try { validateStrategy(raw, 'strategy.yaml'); } catch { valid = false; }
    cases.push({ op: 'validate', value: raw });
    expected.push({ valid });
  }
  for (const [field, value] of [
    ['dispatchStepId', '😀'.repeat(256)],
    ['dispatchStepId', '😀'.repeat(257)],
    ['terminalOpen', '😀'.repeat(1000)],
    ['terminalOpen', '😀'.repeat(1001)],
  ] as const) {
    const raw = Bun.YAML.parse(before) as Record<string, any>;
    if (field === 'dispatchStepId') raw.dispatch = { steps: [{ id: value }] };
    else raw.terminal = { open: value };
    let valid = true;
    try { validateStrategy(raw, 'strategy.yaml'); } catch { valid = false; }
    cases.push({ op: 'validate', value: raw });
    expected.push({ valid });
  }
  const binary = hostBinary();
  const run = Bun.spawn([binary], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd: root });
  run.stdin.write(cases.map(value => JSON.stringify(value)).join('\n') + '\n');
  run.stdin.end();
  const output = await new Response(run.stdout).text();
  const error = await new Response(run.stderr).text();
  expect(await run.exited, error).toBe(0);
  const actual = output.trim().split('\n').map(line => JSON.parse(line));
  for (let i = 0; i < cases.length; i++) expect(actual[i], JSON.stringify(cases[i])).toEqual(expected[i]);
  expect(actual).toEqual(expected);
}, 120_000);
