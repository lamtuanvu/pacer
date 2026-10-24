import { expect, test } from 'bun:test';
import { validateClassifier } from '../src/config/classifier';
import { classifierSnapshot } from '../src/plugins/classifier-config';
test('selected classifier snapshot binds exact destination and only a secret reference', () => {
  const cfg = validateClassifier({ adapters: { ollama: { base_url: 'https://REMOTE.example/v1', key_env: 'CUSTOM_KEY' } } }, {});
  const value = classifierSnapshot(cfg, 'ollama');
  expect(value.hosts).toEqual(['remote.example']);
  expect(value.external).toBe(true);
  expect(value.config).toMatchObject({ keyRef: 'secrets:CUSTOM_KEY', baseUrl: 'https://REMOTE.example/v1' });
  expect(JSON.stringify(value)).not.toContain('keyEnv');
  cfg.adapters.ollama.model = 'changed';
  expect(value.config.model).not.toBe('changed');
  expect(Object.isFrozen(value.config)).toBe(true);
  expect(Object.isFrozen(value.hosts)).toBe(true);
});
test('rules and local classifications carry no remote authority', () => {
  const cfg = validateClassifier(undefined, {});
  expect(classifierSnapshot(cfg, 'rules')).toEqual({ config: {}, hosts: [], external: false });
  expect(classifierSnapshot(cfg, 'ollama').external).toBe(false);
  expect(classifierSnapshot(cfg, 'jev').config.keyRef).toBe('secrets:TYPESAFE_API_KEY');
});

test('unusual configured secret names use host-owned aliases without narrowing config', async () => {
  const { createCallAuthority } = await import('../src/plugins/authority');
  const { secretPresence } = await import('../src/plugins/http-authority');
  const { fakeCtx } = await import('./helpers');
  const cfg = validateClassifier({ adapters: { ollama: { key_env: 'A/B' } } }, {});
  const snapshot = classifierSnapshot(cfg, 'ollama');
  expect(snapshot.config.keyRef).toMatch(/^secrets:[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
  const aliases = (snapshot as any).secretAliases;
  const ctx = fakeCtx({ env: { 'A/B': 'owned-fixture-value' } });
  const a = createCallAuthority(ctx, { reads: [], commands: [], stores: [], secretAliases: aliases } as any, { grants: ['secrets.resolve'], deadlineMs: Date.now() + 1000 });
  try {
    expect(await secretPresence(a, snapshot.config.keyRef)).toEqual({ present: true });
    expect(JSON.stringify(snapshot)).not.toContain('owned-fixture-value');
  } finally { await a.revoke(); }
});
