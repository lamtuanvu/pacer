import { expect, test, spyOn } from 'bun:test';
import { createPlatform, platform } from '../app/src/platform';
import { createBrowserPlatform } from '../app/src/platform/browser';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('browser retains same-origin service transport and connection subscription', async () => {
  const calls: unknown[] = [];
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation((async (url, init) => { calls.push([url, init]); return Response.json({ result: 7 }); }) as typeof fetch);
  try {
    for (const adapter of [createPlatform({})]) {
      expect(await (await adapter.request('/v3/ops/task.get', { method: 'POST', credentials: 'same-origin', body: '{}' })).json()).toEqual({ result: 7 });
      const states: string[] = [];
      const stop = adapter.subscribeConnection(status => states.push(status));
      adapter.setConnectionStatus('connected'); stop(); adapter.setConnectionStatus('reconnecting');
      expect(states).toEqual(['connecting', 'connected']);
    }
    expect(calls).toHaveLength(1);
  } finally { fetcher.mockRestore(); }
});

test('desktop captures its bridge once and keeps native commands and errors', async () => {
  const commands: unknown[] = [];
  const host = { __TAURI__: { core: { invoke: async (command: string, args?: Record<string, unknown>) => { commands.push([command,args]); if(command === 'desktop_version') return '1.2.3'; if(command === 'windowClose') throw Error('closed'); return true; } } } };
  const adapter = createPlatform(host);
  host.__TAURI__.core.invoke = async () => { throw Error('replacement'); };
  expect(adapter.desktop).toBe(true);
  expect(await adapter.readDesktopVersion()).toBe('1.2.3');
  await adapter.clientControl({type:'quit'});
  await adapter.windowControls.minimize();
  await expect(adapter.windowControls.close()).rejects.toThrow('closed');
  expect(commands).toContainEqual(['client_control',{action:{type:'quit'}}]);
  expect(commands).toContainEqual(['windowMinimize',undefined]);
  expect(platform).toBe(platform);
});

test('browser capabilities fail closed and desktop suppresses page notifications', async () => {
  const browser = createBrowserPlatform();
  expect(browser.desktop).toBe(false);
  expect(await browser.readRoundedWindowSupport()).toBe(false);
  expect(await browser.readNativeTitlebarSupport()).toBe(false);
  expect(await browser.readDesktopVersion()).toBeNull();
  await expect(browser.clientControl({type:'quit'})).rejects.toThrow('unsupported');
  await expect(browser.openDesktopTakeover()).rejects.toThrow('Desktop takeover unavailable');
  expect(await createPlatform({__TAURI__:{core:{invoke:async()=>true}}}).notify('Title')).toBe(false);
});

test('Tauri detection is confined to the platform boundary', () => {
  const walk = (dir: string): string[] => readdirSync(dir,{withFileTypes:true}).flatMap(entry => entry.isDirectory() ? walk(join(dir,entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir,entry.name)] : []);
  const offenders = walk('app/src').filter(path => !path.startsWith('app/src/platform/') && readFileSync(path,'utf8').includes('__TAURI__'));
  expect(offenders).toEqual([]);
});

test('browser constructs event and terminal transports without changing paths or frames', () => {
  const events: string[] = [], sockets: string[] = [], frames: unknown[] = [];
  class Events { constructor(path: string) { events.push(path); } close() {} }
  class Socket { constructor(url: string) { sockets.push(url); } send(frame: unknown) { frames.push(frame); } close() {} }
  const originalEvents = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: Events });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  try {
    for (const adapter of [createPlatform({})]) {
      adapter.subscribeEvents('/v3/events?since=8').close();
      const socket = adapter.attachTerminal('ws://localhost/v3/tasks/t1/session');
      socket.send('hello'); socket.close();
    }
    expect(events).toEqual(['/v3/events?since=8']);
    expect(sockets).toEqual(['ws://localhost/v3/tasks/t1/session']);
    expect(frames).toEqual(['hello']);
  } finally {
    if (originalEvents) Object.defineProperty(globalThis,'EventSource',originalEvents); else Reflect.deleteProperty(globalThis,'EventSource');
    if (originalSocket) Object.defineProperty(globalThis,'WebSocket',originalSocket); else Reflect.deleteProperty(globalThis,'WebSocket');
  }
});

test('picker cancellation is empty, unsupported pickers and permission errors stay explicit', async () => {
  const host = globalThis as typeof globalThis & { showOpenFilePicker?: (options: {multiple: boolean}) => Promise<{kind:'file';getFile():Promise<File>}[]>; showDirectoryPicker?: () => Promise<unknown> };
  const original = Object.getOwnPropertyDescriptor(host,'showOpenFilePicker');
  try {
    Object.defineProperty(host,'showOpenFilePicker',{configurable:true,value:async () => { throw new DOMException('cancelled','AbortError'); }});
    expect(await createBrowserPlatform().pickFiles()).toEqual([]);
    Object.defineProperty(host,'showOpenFilePicker',{configurable:true,value:async () => { throw new DOMException('denied','NotAllowedError'); }});
    await expect(createBrowserPlatform().pickFiles()).rejects.toThrow('denied');
    const file = new File(['contents'],'a.txt');
    Object.defineProperty(host,'showOpenFilePicker',{configurable:true,value:async (options: {multiple: boolean}) => { expect(options.multiple).toBe(true); return [{kind:'file',getFile:async()=>file}]; }});
    expect(await createBrowserPlatform().pickFiles({multiple:true})).toEqual([file]);
    Reflect.deleteProperty(host,'showOpenFilePicker');
    await expect(createBrowserPlatform().pickFiles()).rejects.toThrow('File picker unavailable');
  } finally { if(original) Object.defineProperty(host,'showOpenFilePicker',original); else Reflect.deleteProperty(host,'showOpenFilePicker'); }
});

test('store reports connecting until open, reconnecting on error and disconnected on stop', async () => {
  const { createStore } = await import('../app/src/data/store');
  const { emptySnapshot } = await import('../src/link/envelope');
  const listeners = new Map<string, () => void>();
  class Events { close() {} addEventListener(name: string, callback: () => void) { listeners.set(name,callback); } }
  const states: string[] = [];
  const unsubscribe = platform.subscribeConnection(status => states.push(status));
  const store = createStore({ hello: async () => ({protocol:'3.0.0',pacer:'1.0.0',ops:[],events:[]}), snapshot: async () => ({protocol:'3.0.0',seq:1,snapshot:emptySnapshot()}), call: async <T>() => ({} as T) },Events as unknown as typeof EventSource);
  const stop = store.start();
  try {
    await new Promise(resolve => setTimeout(resolve,0));
    expect(states.at(-1)).toBe('connecting');
    listeners.get('open')!(); expect(states.at(-1)).toBe('connected');
    listeners.get('error')!(); expect(states.at(-1)).toBe('reconnecting');
    stop(); expect(states.at(-1)).toBe('disconnected');
  } finally { stop(); unsubscribe(); }
});
