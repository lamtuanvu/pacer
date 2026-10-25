import { unavailableFilesystem } from "./fixtures/unavailable-filesystem";
import { expect, test, spyOn } from 'bun:test';
import { PluginError } from '@pacer/plugin';
import type { HostClient } from '@pacer/plugin';
import { handlers, manifest } from '../plugins/pacer-notify';
const note = { key: 'task:owned:1', title: 'Task done', body: 'fix login', url: '/app/#/review/owned' };
interface Spawn { code: number; stdout?: string; stderr?: string; timedOut?: boolean }
function fixture(platform: unknown = 'darwin', spawn: (params: any) => Promise<Spawn> = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false })) {
  const calls: { method: string; params: unknown }[] = [], logs: unknown[] = [];
  const controller = new AbortController();
  const host: HostClient = { fs: unavailableFilesystem,
    async call<T>(method: string, params: unknown) { calls.push({ method, params }); return await spawn(params) as T; },
    async config() { return { platform, which: { osascript: '/untrusted/override' }, binary: '/untrusted/override' }; },
    async log(level, message) { logs.push({ level, message }); },
    http: async () => { throw Error('unexpected HTTP'); }, secrets: { present: async () => { throw Error('unexpected secrets'); } },
  };
  return { host, calls, logs, controller, deliver: (params: unknown = note) => handlers['notifier.deliver'](params, host, controller.signal) };
}
test('manifest names precise notifier contribution and only required tool scopes', () => {
  expect(manifest.host).toBe('^1.3');
  expect(manifest.contributes.notifier.kinds).toEqual(['os']);
  expect(manifest.capabilities).toEqual([{ name: 'process.spawn', scopes: ['osascript', 'notify-send'] }, { name: 'config.get' }, { name: 'log' }]);
});
test('macOS preserves exact fixed script and treats quotes/newlines/shell text as literal arguments', async () => {
  const f = fixture(), title = 'Title "quoted"\\\n$(touch owned)', body = 'Body "\\\n`echo owned`';
  expect(await f.deliver({ ...note, title, body })).toEqual({ delivered: true });
  expect(f.calls).toEqual([{ method: 'capability.process.spawn', params: {
    argv: ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body], timeoutMs: 5000,
  } }]);
});
test('Linux uses bare fixed tool with -- and no config binary or URL argument', async () => {
  const f = fixture('linux');
  expect(await f.deliver({ ...note, title: '-title', body: '--body' })).toEqual({ delivered: true });
  expect(f.calls).toEqual([{ method: 'capability.process.spawn', params: { argv: ['notify-send', '--', '-title', '--body'], timeoutMs: 5000 } }]);
});
for (const result of [{ code: 127 }, { code: 1 }, { code: 124, timedOut: true }, { code: 0, timedOut: true }]) {
  test(`spawn failure code=${result.code} timedOut=${result.timedOut} reports undelivered`, async () => {
    const f = fixture('linux', async () => result);
    expect(await f.deliver()).toEqual({ delivered: false });
    expect(f.calls).toHaveLength(1);
  });
}
test('spawn error logs only safe fixed warning; warning failure does not escape', async () => {
  const f = fixture('darwin', async () => { throw Error('secret fixture /private/owned-path'); });
  expect(await f.deliver()).toEqual({ delivered: false });
  expect(f.logs).toEqual([{ level: 'warn', message: 'OS notification delivery failed' }]);
  f.host.log = async () => { throw Error('logging unavailable'); };
  expect(await f.deliver()).toEqual({ delivered: false });
});
test('already cancelled or unsupported platform emits no spawn', async () => {
  const cancelled = fixture(); cancelled.controller.abort();
  expect(await cancelled.deliver()).toEqual({ delivered: false }); expect(cancelled.calls).toHaveLength(0);
  for (const platform of ['win32', 'other', undefined]) {
    const f = fixture(platform); if (platform === undefined) f.host.config = async () => ({});
    expect(await f.deliver()).toEqual({ delivered: false }); expect(f.calls).toHaveLength(0);
  }
});
test('cancellation during spawn cannot become delivered even if tool returns zero', async () => {
  const f = fixture('darwin', async () => { f.controller.abort(); return { code: 0 }; });
  expect(await f.deliver()).toEqual({ delivered: false });
});
test('valid bounds include opaque key/url and exact title/body maxima', async () => {
  const f = fixture('linux');
  expect(await f.deliver({ key: '', url: '', title: 'x'.repeat(256), body: 'x'.repeat(2048) })).toEqual({ delivered: true });
});
test('invalid notifier fields are refused before config or spawning', async () => {
  const f = fixture(); let configs = 0; f.host.config = async () => { configs++; return { platform: 'darwin' }; };
  for (const input of [null, {}, { ...note, key: 1 }, { ...note, url: 1 }, { ...note, title: 'x'.repeat(257) }, { ...note, body: 'x'.repeat(2049) }]) {
    await expect(f.deliver(input)).rejects.toMatchObject({ code: 'invalid_input' });
  }
  expect(configs).toBe(0); expect(f.calls).toHaveLength(0);
});

test('throwing timeout remains safe and config cancellation emits no spawn', async () => {
  const timedOut = fixture('linux', async () => { throw new PluginError('plugin_timeout', 'private fixture timeout detail'); });
  expect(await timedOut.deliver()).toEqual({ delivered: false });
  expect(timedOut.logs).toEqual([{ level: 'warn', message: 'OS notification delivery failed' }]);
  const cancelled = fixture();
  cancelled.host.config = async () => { cancelled.controller.abort(); return { platform: 'darwin' }; };
  expect(await cancelled.deliver()).toEqual({ delivered: false });
  expect(cancelled.calls).toHaveLength(0);
});
test('plugin never resolves tools through ambient Bun.which', async () => {
  const lookup = spyOn(Bun, 'which').mockImplementation(() => { throw Error('ambient tool lookup forbidden'); });
  try {
    const f = fixture('linux');
    expect(await f.deliver()).toEqual({ delivered: true });
    expect(lookup).not.toHaveBeenCalled();
  } finally { lookup.mockRestore(); }
});
