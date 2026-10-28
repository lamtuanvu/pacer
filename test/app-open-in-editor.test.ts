import { expect, test } from 'bun:test';
import { editorHandler, readHostActions, revealHandler, sessionFileReference } from '../app/src/desktop/host-actions';

type Call = { command: string; args?: Record<string, unknown> };
function shell(supported: unknown, calls: Call[] = [], fail?: string) {
  return { __TAURI__: { core: { invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === 'host_file_actions') return supported;
    if (fail) throw fail;
    return null;
  } } } };
}

test('browsers, older shells and unsupported platforms get no host actions', async () => {
  expect(await readHostActions({})).toBe(null);
  expect(await readHostActions({ __TAURI__: { core: { invoke: async () => { throw Error('unknown command'); } } } })).toBe(null);
  expect(await readHostActions(shell({ open: false, reveal: false, revealLabel: null }))).toBe(null);
  expect(await readHostActions(shell('yes'))).toBe(null);
  expect(editorHandler(null, { id: 't', attempt: 2 })).toBeUndefined();
  expect(revealHandler(null, { id: 't', attempt: 2 })).toBeUndefined();
});

test('the desktop passes only a session reference to native code', async () => {
  const calls: Call[] = [];
  const actions = await readHostActions(shell({ open: true, reveal: true, revealLabel: 'Reveal in Finder' }, calls));
  expect(actions?.reveal?.label).toBe('Reveal in Finder');
  const open = editorHandler(actions, { id: 't-1', attempt: 3 })!;
  open('src/main.ts', 42);
  revealHandler(actions, { id: 't-1', attempt: 3 })!.run('src/main.ts');
  await Promise.resolve();
  expect(calls.slice(1)).toEqual([
    { command: 'open_session_file', args: { id: 't-1', attempt: 3, reference: 'src/main.ts:42', action: 'open' } },
    { command: 'open_session_file', args: { id: 't-1', attempt: 3, reference: 'src/main.ts', action: 'reveal' } },
  ]);
});

test('a session without a known attempt offers no hand-off', async () => {
  const actions = await readHostActions(shell({ open: true, reveal: false, revealLabel: null }));
  expect(actions?.reveal).toBeUndefined();
  expect(editorHandler(actions, { id: 't-1', attempt: null })).toBeUndefined();
});

test('native refusals reach the caller as a message', async () => {
  const actions = await readHostActions(shell({ open: true, reveal: true, revealLabel: 'Show in folder' }, [], 'File changed since it was checked'));
  const errors: string[] = [];
  editorHandler(actions, { id: 't-1', attempt: 1 }, message => errors.push(message))!('a.bin');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(errors).toEqual(['File changed since it was checked']);
});

test('references carry a positive line only', () => {
  expect(sessionFileReference('a.ts', 7)).toBe('a.ts:7');
  expect(sessionFileReference('a.ts', 0)).toBe('a.ts');
  expect(sessionFileReference('a.ts')).toBe('a.ts');
});
