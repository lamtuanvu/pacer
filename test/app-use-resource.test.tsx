import { expect, test } from 'bun:test';
import { resourceRevision } from '../app/src/screens/settings/shared';

test('useResource is exported from settings shared', async () => {
  const mod = await import('../app/src/screens/settings/shared');
  expect(typeof mod.useResource).toBe('function');
});

test('resourceRevision keeps a background refresh key stable when only refreshing', () => {
  const first = resourceRevision('plugin.list', { plugin: 1 });
  const second = resourceRevision('plugin.list', { plugin: 1 });
  expect(first).toBe(second);
});