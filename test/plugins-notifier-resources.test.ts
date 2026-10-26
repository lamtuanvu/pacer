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
