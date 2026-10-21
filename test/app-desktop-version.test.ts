import { expect, test } from 'bun:test';
import { readDesktopVersion } from '../app/src/data/desktop';
import { desktopUpdateModel } from '../src/view-model/updates';

test('browser has no desktop version; native version comes from the shell', async () => {
  expect(await readDesktopVersion({})).toBe(null);
  expect(await readDesktopVersion({ __TAURI__: { core: { invoke: async command => {
    expect(command).toBe('desktop_version');
    return '0.3.1';
  } } } })).toBe('0.3.1');
});

test('older shells and failed IPC expose unknown, never the service version', async () => {
  await expect(readDesktopVersion({ __TAURI__: { core: { invoke: async () => { throw Error('unknown command'); } } } })).rejects.toThrow();
  await expect(readDesktopVersion({ __TAURI__: { core: { invoke: async () => 5 } } })).rejects.toThrow();
});

test('desktop update is independent of an up-to-date service', () => {
  expect(desktopUpdateModel('0.3.1', {latest:'0.5.0'})).toEqual({label:'Update available: 0.5.0',canUpdate:true});
  expect(desktopUpdateModel('0.5.0', {latest:'0.5.0'}).label).toBe('Up to date');
  expect(desktopUpdateModel('0.10.0', {latest:'0.5.0'}).canUpdate).toBe(false);
  expect(desktopUpdateModel(null, {latest:'0.5.0'}).label).toBe('Version unavailable');
  for (const report of [{latest:null}, {latest:'0.5.0',error:'offline'}, {latest:'0.5.0',disabled:true}]) {
    expect(desktopUpdateModel('0.3.1',report).canUpdate).toBe(false);
    expect(desktopUpdateModel('0.3.1',report).label).not.toBe('Up to date');
  }
  expect(desktopUpdateModel('0.5.0-dev', {latest:'0.5.0'}).label).toBe('Not checked');
});
