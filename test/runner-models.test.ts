import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeCtx } from './helpers';
const runnerCtx = () => {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, {recursive:true});
  writeFileSync(join(ctx.pacerHome, 'strategy.yaml'), `# keep runner
planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
runners:
  codex: {}
routing:
  - kinds: [docs]
    executors: [codex]
  - default: [codex]
`);
  return ctx;
};
const declaredCtx = () => {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, {recursive:true});
  writeFileSync(join(ctx.pacerHome, 'strategy.yaml'), `# keep runner
planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
runners:
  codex:
    model: acme/a
    models:
      - {id: acme/a, tier: small}
      - {id: acme/b, tier: medium}
`);
  return ctx;
};
import { readRunnerModels, saveRunnerModels, modelDeclarationWarnings } from '../src/core/runner-models';
import { main } from '../src/cli';
import { loadStrategy } from '../src/config/strategy';

test('saves default and tiered models in one edit', async () => {
  const ctx = runnerCtx(), base = readRunnerModels(ctx, 'codex');
  expect(base).toMatchObject({runner: 'codex', default: null, models: []});
  const result = await saveRunnerModels(ctx, {id: 'codex', expectedRevision: base.revision, default: 'acme/a',
    models: [{id: 'acme/a', tier: 'small'}, {id: 'acme/b', tier: 'frontier', strengths: ['deep', 'review']}]});
  expect(result.revision).not.toBe(base.revision);
  expect(result.runner).toBe('codex');
  expect(result.default).toBe('acme/a');
  expect(result.warnings).toEqual([]);
  const s = loadStrategy(ctx);
  expect(s.runners.codex.model).toBe('acme/a');
  expect(s.runners.codex.models).toEqual([...s.runners.codex.models!].map(m => ({id: m.id, tier: m.tier, strengths: m.strengths ?? []})));
  expect(s.runners.codex.models).toMatchObject([{id: 'acme/a', tier: 'small'}, {id: 'acme/b', tier: 'frontier', strengths: ['deep', 'review']}]);
  expect(readFileSync(join(ctx.pacerHome, 'strategy.yaml'), 'utf8')).toContain('# keep runner');
});

test('refuses a default outside the list', async () => {
  const ctx = runnerCtx(), base = readRunnerModels(ctx, 'codex'), path = join(ctx.pacerHome, 'strategy.yaml'), before = readFileSync(path, 'utf8');
  await expect(saveRunnerModels(ctx, {id: 'codex', expectedRevision: base.revision, default: 'acme/c',
    models: [{id: 'acme/a', tier: 'small'}]})).rejects.toMatchObject({code: 'invalid_input'});
  expect(readFileSync(path, 'utf8')).toBe(before);
});

test('refuses a stale revision and writes nothing', async () => {
  const ctx = runnerCtx(), base = readRunnerModels(ctx, 'codex'), path = join(ctx.pacerHome, 'strategy.yaml');
  const before = readFileSync(path, 'utf8');
  writeFileSync(path, `${before}\n# another client\n`);
  await expect(saveRunnerModels(ctx, {id: 'codex', expectedRevision: base.revision, default: 'acme/a',
    models: [{id: 'acme/a', tier: 'small'}]})).rejects.toMatchObject({code: 'conflict'});
  expect(readFileSync(path, 'utf8')).toBe(`${before}\n# another client\n`);
});

test('an empty list removes models and keeps the default', async () => {
  const ctx = declaredCtx();
  expect(readRunnerModels(ctx, 'codex')).toMatchObject({default: 'acme/a', models: [{id: 'acme/a', tier: 'small'}, {id: 'acme/b', tier: 'medium'}]});
  const result = await saveRunnerModels(ctx, {id: 'codex', expectedRevision: readRunnerModels(ctx, 'codex').revision, default: 'acme/a', models: []});
  expect(result.default).toBe('acme/a');
  expect(result.models).toEqual([]);
  const s = loadStrategy(ctx);
  expect(s.runners.codex.model).toBe('acme/a');
  expect(s.runners.codex.models).toBeUndefined();
  expect(readFileSync(join(ctx.pacerHome, 'strategy.yaml'), 'utf8')).not.toContain('models:');
});

test('a hand-edited default outside models is reported by modelDeclarationWarnings', () => {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, {recursive:true});
  writeFileSync(join(ctx.pacerHome, 'strategy.yaml'), `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
runners:
  codex:
    model: acme/b
    models:
      - {id: acme/a, tier: small}
`);
  const s = loadStrategy(ctx); // must not be an error
  expect(Object.hasOwn(s.runners.codex, 'modelWarnings')).toBe(false); // no extra field on the parsed strategy
  expect(modelDeclarationWarnings(s.runners.codex)).toEqual(['runners.codex: default model "acme/b" is not in models']);
});

test('unrated models are reported by modelDeclarationWarnings', () => {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, {recursive:true});
  writeFileSync(join(ctx.pacerHome, 'strategy.yaml'), `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
runners:
  codex:
    model: acme/a
    models:
      - {id: acme/a, tier: unknown}
      - {id: acme/b, tier: medium}
`);
  const s = loadStrategy(ctx); // must not be an error
  expect(Object.hasOwn(s.runners.codex, 'modelWarnings')).toBe(false); // no extra field on the parsed strategy
  expect(modelDeclarationWarnings(s.runners.codex)).toEqual(['runners.codex: model "acme/a" is unrated (tier unknown)']);
});

test('pacer executor models --allow a:small --default a saves both', async () => {
  const ctx = runnerCtx();
  const save = await main(['executor', 'models', 'codex', '--allow', 'acme/a:small', '--allow', 'acme/b:frontier', '--default', 'acme/a'], ctx);
  expect(save.code).toBe(0);
  const s = loadStrategy(ctx);
  expect(s.runners.codex.model).toBe('acme/a');
  expect(s.runners.codex.models).toMatchObject([{id: 'acme/a', tier: 'small'}, {id: 'acme/b', tier: 'frontier'}]);
  const read = await main(['executor', 'models', 'codex'], ctx);
  expect(read.code).toBe(0);
  expect(read.out).toContain('acme/a');
  expect(read.out).toContain('acme/b');
});

test('model YAML omits empty strengths but preserves explicitly supplied metadata', async () => {
  const ctx = runnerCtx(), base = readRunnerModels(ctx, 'codex');
  await saveRunnerModels(ctx, {id: 'codex', expectedRevision: base.revision, default: 'a',
    models: [{id: 'a', tier: 'small', strengths: [], tools: false, context: 32000}, {id: 'b', tier: 'medium', strengths: ['review']}]});
  const text = readFileSync(join(ctx.pacerHome, 'strategy.yaml'), 'utf8');
  expect(text).not.toContain('strengths: []');
  expect(text.match(/strengths:/g)).toHaveLength(1);
  expect(loadStrategy(ctx).runners.codex.models).toMatchObject([{id: 'a', tools: false, context: 32000}, {id: 'b', strengths: ['review']}]);
});

for (const concurrentEdit of [false, true]) {
  test(`provider listing runs outside the settings lock (concurrent edit: ${concurrentEdit})`, async () => {
    const ctx = runnerCtx(), path = join(ctx.pacerHome, 'strategy.yaml');
    writeFileSync(path, `planner: claude-code
accounts:
  claude: {kind: claude}
  go: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}
runners:
  opencode#go: {model: acme/a}
`);
    const base = readRunnerModels(ctx, 'opencode#go');
    let probed = false;
    ctx.run = async () => {
      probed = true;
      expect(existsSync(join(ctx.pacerHome, 'orca', 'executor-settings.lock'))).toBe(false);
      if (concurrentEdit) writeFileSync(path, readFileSync(path, 'utf8') + '\n# concurrent edit\n');
      return {code: 0, stdout: 'acme/a\n', stderr: ''};
    };
    const saving = saveRunnerModels(ctx, {id: 'opencode#go', expectedRevision: base.revision, default: 'acme/a', models: [{id: 'acme/a', tier: 'small'}]});
    if (concurrentEdit) {
      await expect(saving).rejects.toMatchObject({code: 'conflict'});
      expect(readFileSync(path, 'utf8')).not.toContain('models:');
    } else expect((await saving).models).toMatchObject([{id: 'acme/a', tier: 'small'}]);
    expect(probed).toBe(true);
  });
}
