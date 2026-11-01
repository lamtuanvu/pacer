import { createBrowserPlatform } from './browser';
import { createDesktopPlatform, type PlatformHost } from './desktop';
import type { Platform } from './types';
export type { Platform, ConnectionStatus } from './types';
export type { DesktopHost, DesktopUpdateConnection, WindowControls } from './native';
export { desktopHost } from './native';
export function createPlatform(host: PlatformHost): Platform {
  return host.__TAURI__ ? createDesktopPlatform(host) : createBrowserPlatform();
}
/** ESM initializes this once, before either page entry constructs a client. */
export const platform = createPlatform(globalThis as typeof globalThis & PlatformHost);
