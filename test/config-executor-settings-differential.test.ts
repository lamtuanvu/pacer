import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readExecutorSettings, saveExecutorSettings } from '../src/core/executor-settings';
import { fakeCtx } from './helpers';

const root = join(import.meta.dir, '..');
const strategy = '# keep runner\nplanner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  codex: {}\nrouting:\n  - kinds: [docs]\n    executors: [codex]\n  - default: [codex]\n';

function home(text = strategy) {
  const dir = mkdtempSync(join(tmpdir(), 'pacer-executor-settings-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'strategy.yaml'), text);
  return { ctx: fakeCtx({ pacerHome: dir }), dir };
}

function settingsBinary() {
  execFileSync('cargo', ['build', '-q', '-p', 'pacer-config', '--example', 'executor_settings_diff', '--locked'], { cwd: root });
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--locked', '--format-version', '1'], { cwd: root }).toString());
  return join(metadata.target_directory, 'debug/examples/executor_settings_diff');
}

function rust(op: string, homeDir: string, input?: unknown) {
  return JSON.parse(execFileSync(settingsBinary(), [], {
    input: JSON.stringify({ op, home: homeDir, input }) + '\n',
    cwd: root,
  }).toString());
}

test('executor settings read/save match Rust library', async () => {
  const { ctx, dir } = home();
  const tsRead = readExecutorSettings(ctx);
  const rustRead = rust('read', dir);
  expect(rustRead).toEqual({ ok: true, value: tsRead });

  const saved = await saveExecutorSettings(ctx, {
    expectedRevision: tsRead.revision,
    order: tsRead.order,
    runners: tsRead.runners.map(r => ({ ...r, enabled: false, maxTasks: 3 })),
  });
  const afterTs = readFileSync(join(dir, 'strategy.yaml'), 'utf8');

  const { ctx: ctx2, dir: dir2 } = home();
  const base2 = readExecutorSettings(ctx2);
  const rustSave = rust('save', dir2, {
    expectedRevision: base2.revision,
    order: base2.order,
    runners: base2.runners.map(r => ({ ...r, enabled: false, maxTasks: 3 })),
  });
  expect(rustSave.ok).toBe(true);
  expect(rustSave.value.runners).toEqual(saved.runners);
  expect(rustSave.value.order).toEqual(saved.order);
  expect(rustSave.value.warnings).toEqual(saved.warnings);
  expect(readFileSync(join(dir2, 'strategy.yaml'), 'utf8')).toBe(afterTs);

  const stale = rust('save', dir2, {
    expectedRevision: base2.revision,
    order: base2.order,
    runners: base2.runners,
  });
  expect(stale.ok).toBe(false);
  expect(stale.error).toContain('changed elsewhere');
}, 120_000);
