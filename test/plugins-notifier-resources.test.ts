import { expect, test } from 'bun:test';
import { notifierResources } from '../src/plugins/notifier-resources';
import { handlers } from '../plugins/pacer-notify';

test('host authorizes precisely the plugin notification vector with literal user arguments', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const title = '--title " & $(nope)';
    const body = 'line one\nline two "';
    const resources = notifierResources(platform, title, body);
    const calls: {argv: string[]; timeoutMs:number}[] = [];
    const host = {
      config: async () => ({ platform }),
      call: async (_method: string, params: unknown) => {
        calls.push(params as {argv: string[]; timeoutMs:number});
        return { code: 0, timedOut: false };
      },
      log: async () => {},
    };
    const reply = await handlers['notifier.deliver']({key:'k',title,body,url:'/app/#/'}, host as never, new AbortController().signal);
    expect(reply).toEqual({delivered:platform !== 'win32'});
    expect(calls.length).toBe(platform === 'win32' ? 0 : 1);
    expect(resources.commands).toEqual(calls);
    expect(resources.reads).toEqual([]);
    expect(resources.stores).toEqual([]);
  }
});

test('notification vectors keep quotes, backslashes, newlines, shell text and leading dashes literal (F7, ported from notify-fallback)', () => {
  const title = 'Title "quoted"\\\n$(touch bad)', body = 'Body "\\\n';
  expect(notifierResources('darwin', title, body).commands).toEqual([{ argv: ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body], timeoutMs: 5000 }]);
  expect(notifierResources('linux', '-title', 'body').commands).toEqual([{ argv: ['notify-send', '--', '-title', 'body'], timeoutMs: 5000 }]);
  expect(notifierResources('win32', 'title', 'body').commands).toEqual([]);
});
