export interface DesktopHost {
  __TAURI__?: { core?: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> } };
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

function isDesktop(host: DesktopHost): boolean {
  return !!host.__TAURI__?.core?.invoke;
}

export const windowControls = (host: DesktopHost = desktopHost()) => {
  const invoke = host.__TAURI__?.core?.invoke;
  return {
    desktop: isDesktop(host),
    minimize: async (): Promise<void> => { if (invoke) await invoke('windowMinimize'); },
    toggleMaximize: async (): Promise<void> => { if (invoke) await invoke('windowToggleMaximize'); },
    close: async (): Promise<void> => { if (invoke) await invoke('windowClose'); },
  };
};
export type WindowControls = ReturnType<typeof windowControls>;
