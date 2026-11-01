import { createBrowserPlatform } from './browser';
import { createDesktopPlatform, type PlatformHost } from './desktop';
import type { Platform } from './types';
export type { Platform, ConnectionStatus } from './types';
export type { DesktopHost, DesktopUpdateConnection, WindowControls } from './native';
export { desktopHost } from './native';
export function createPlatform(host: PlatformHost): Platform {
  return host.__TAURI__ ? createDesktopPlatform(host) : createBrowserPlatform();
}
let current: { desktop: boolean; platform: Platform } | undefined;
/** Re-checks the host on use, as the pre-adapter code did, so a shell injected after load is still found. */
function resolve(): Platform {
  const host = globalThis as typeof globalThis & PlatformHost, desktop = !!host.__TAURI__;
  if (current?.desktop !== desktop) current = { desktop, platform: createPlatform(host) };
  return current.platform;
}
export const platform: Platform = new Proxy({} as Platform, { get: (_, key) => Reflect.get(resolve(), key) });
