export interface DesktopHost {
  __TAURI__?: { core?: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> } };
}
export function desktopHost(): DesktopHost {
  return globalThis as typeof globalThis & DesktopHost;
}
/** Older opaque shells do not expose this command; keep their canvas square. */
export async function readRoundedWindowSupport(host: DesktopHost = desktopHost()): Promise<boolean> {
  const invoke = host.__TAURI__?.core?.invoke;
  if (!invoke) return false;
  try { return await invoke('rounded_window_supported') === true; }
  catch { return false; }
}
/** Only the macOS main window uses Tauri's native title-bar overlay. */
export async function readNativeTitlebarSupport(host: DesktopHost = desktopHost()): Promise<boolean> {
  const invoke = host.__TAURI__?.core?.invoke;
  if (!invoke) return false;
  try { return await invoke('native_titlebar_supported') === true; }
  catch { return false; }
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

export type DesktopUpdateConnection = {
  state: "connecting" | "available" | "unavailable" | "unsupported";
  reason: "service-identity" | "service-takeover" | "connection" | null;
  terminalCommandDifferent?: boolean;
};
/** The service page can request the bundled confirmation page, never confirm a takeover. */
export async function openDesktopTakeover(host: DesktopHost = desktopHost()): Promise<void> {
  const invoke = host.__TAURI__?.core?.invoke;
  if (!invoke) throw Error("Desktop takeover unavailable");
  await invoke("takeover_open");
}
/** Read-only native diagnostics; a service snapshot cannot establish shell authority. */
export async function readDesktopUpdateConnection(host: DesktopHost = desktopHost()): Promise<DesktopUpdateConnection | null> {
  const invoke = host.__TAURI__?.core?.invoke;
  if (!invoke) return null;
  const value = await invoke("desktop_update_connection", { supports: ["service-takeover"] }) as Partial<DesktopUpdateConnection> | null;
  if (!value || !["connecting", "available", "unavailable", "unsupported"].includes(value.state ?? "") ||
      (value.reason === undefined || ![null, "service-identity", "service-takeover", "connection"].includes(value.reason)) ||
      (value.terminalCommandDifferent !== undefined && typeof value.terminalCommandDifferent !== "boolean") ||
      (value.state !== "unavailable" && value.reason !== null)) throw Error("Desktop update connection unavailable");
  return value as DesktopUpdateConnection;
}
