import { expect, test } from 'bun:test';
import { NOTIFIER_METHODS } from '../src/plugins/notifier-protocol';
test('notifier delivery schema preserves message fields and has a five second budget', () => {
  const method = NOTIFIER_METHODS['notifier.deliver'];
  expect(method).toBeDefined();
  const message = { key: 'attention:1', title: 'Task done', body: 'literal "text"\nnext line', url: '/app/#/tasks/t1' };
  expect(method!.params.parse(message)).toEqual(message);
  expect(method!.deadlineMs).toBe(5000);
  expect(method!.result.parse({ delivered: false })).toEqual({ delivered: false });
});
test('notifier input limits refuse malformed and oversized fields without narrowing delivery results', () => {
  const method = NOTIFIER_METHODS['notifier.deliver']!;
  expect(method).toBeDefined();
  const message = { key: 'k', title: 't', body: 'b', url: '/app/#/' };
  for (const change of [{ title: 'x'.repeat(257) }, { body: 'x'.repeat(2049) }, { key: 1 }, { url: null }]) {
    expect(method.params.safeParse({ ...message, ...change }).success).toBe(false);
  }
  expect(method.params.safeParse({ ...message, title: 'x'.repeat(256), body: 'x'.repeat(2048) }).success).toBe(true);
  expect(method.result.safeParse({ delivered: true }).success).toBe(true);
});

import { EXTENSION_METHODS, EXTENSION_POINTS, PLUGIN_PROTOCOL_VERSION, manifestSchema } from '../src/plugins/protocol';
test('canonical protocol negotiates notifier delivery and accepts notifier manifests', () => {
  expect(PLUGIN_PROTOCOL_VERSION).toBe('1.6.0');
  expect(EXTENSION_POINTS).toContain('notifier');
  expect(EXTENSION_METHODS['notifier.deliver']).toBe(NOTIFIER_METHODS['notifier.deliver']);
  expect(manifestSchema.safeParse({id:'pacer-notify',version:'0.1.0',publisher:'pacer',host:'^1.6',contributes:{notifier:{kinds:['os']}}}).success).toBe(true);
});

import { BUNDLED } from '../plugins/bundled';
test('notifier is present in the compiled bundle catalog', () => {
  expect(BUNDLED.find(b => b.manifest.id === 'pacer-notify')?.manifest.contributes.notifier).toEqual({kinds:['os']});
});
