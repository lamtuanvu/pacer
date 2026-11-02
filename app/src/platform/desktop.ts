import { createIpcTransport } from './ipc';
import { createBrowserPlatform } from './browser';
import * as native from './native';
import { createTrayIpc, type TrayHost } from './tray';
import type { Platform } from './types';
import type { NativeValidationSetupResult } from '../desktop/validation';

export type PlatformHost = native.DesktopHost & Partial<Pick<TrayHost, 'location'>>;
/** Capture the bridge at startup; subsequent shell-global changes cannot switch transports. */
export function createDesktopPlatform(host: PlatformHost): Platform {
  const invoke = host.__TAURI__?.core?.invoke;
  const captured = { __TAURI__: { core: invoke ? { invoke } : undefined } };
  return {
    ...createBrowserPlatform(),
    ...createIpcTransport(host.__TAURI__?.core),
    desktop: true,
    openExternal: url => { (host.location ?? globalThis.location)?.assign(url); },
    windowControls: native.windowControls(captured),
    readRoundedWindowSupport: () => native.readRoundedWindowSupport(captured),
    readNativeTitlebarSupport: () => native.readNativeTitlebarSupport(captured),
    readDesktopVersion: () => native.readDesktopVersion(captured),
    readDesktopUpdateConnection: () => native.readDesktopUpdateConnection(captured),
    openDesktopTakeover: () => native.openDesktopTakeover(captured),
    reportSessionEnded: () => { void invoke?.('session_expired').catch(() => { /* shell may already be navigating to recovery */ }); },
    clientControl: async action => { if (!invoke) throw Error('unsupported'); return invoke('client_control', { action }); },
    nativeValidationSupported: (globalThis.navigator?.platform ?? '').startsWith('Mac') && !!invoke,
    setupNativeValidation: async () => {
      if (!(globalThis.navigator?.platform ?? '').startsWith('Mac') || !invoke) throw Error('Native setup requires the macOS desktop app');
      return await invoke('native_validation_setup') as NativeValidationSetupResult;
    },
    // Rust already owns desktop notification delivery.
    notify: async () => false,
    tray: createTrayIpc({ ...host, location: host.location ?? { assign() {} } }),
  };
}
