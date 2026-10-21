export interface DesktopHost {
  __TAURI__?: { core?: { invoke(command: string): Promise<unknown> } };
}
export function desktopHost(): DesktopHost {
  return globalThis as typeof globalThis & DesktopHost;
}
/** Never substitute the service or web bundle version for the native shell. */
export async function readDesktopVersion(host: DesktopHost = desktopHost()): Promise<string | null> {
  const invoke = host.__TAURI__?.core?.invoke;
  if (!invoke) return null;
  const version = await invoke('desktop_version');
  if (typeof version !== 'string' || !version.trim()) throw Error('Desktop version unavailable');
  return version;
}
