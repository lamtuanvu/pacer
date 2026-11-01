import { expect, test } from 'bun:test';
import { StrategyDoc } from '../src/config/edit';
import { repoKey } from '../src/config/hosts';

type Case = Record<string, unknown>;
const before = '# keep comment\nplanner: codex\nproviders: {codex: {}}\nhosts:\n  devbox: {ssh: devbox, repos: {}}\n';
const next = (() => { let state = 0x2381; return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0); })();

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
  const build = Bun.spawnSync(['cargo', 'build', '-p', 'pacer-config', '--example', 'host_diff', '--locked'], { stdout: 'pipe', stderr: 'pipe' });
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
  const run = Bun.spawn(['./target/debug/examples/host_diff'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  run.stdin.write(cases.map(value => JSON.stringify(value)).join('\n') + '\n');
  run.stdin.end();
  const output = await new Response(run.stdout).text();
  const error = await new Response(run.stderr).text();
  expect(await run.exited, error).toBe(0);
  const actual = output.trim().split('\n').map(line => JSON.parse(line));
  expect(actual).toEqual(expected);
});
