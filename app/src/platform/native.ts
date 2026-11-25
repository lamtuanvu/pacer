export interface DesktopHost {
  __TAURI__?: { core?: import('./ipc').IpcCore };
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
  reason: "service-identity" | "service-takeover" | "handshake" | "connection" | null;
  /** Present only when `reason` is "connection"; absent from older desktops. */
  error?: "unavailable" | "invalid" | "io" | "busy" | "timeout" | "interrupted" | "recovery-failed";
  terminalCommandDifferent?: boolean;
};
const KNOWN_REASONS = ["service-identity", "service-takeover", "handshake", "connection"];
const KNOWN_ERRORS = ["unavailable", "invalid", "io", "busy", "timeout", "interrupted", "recovery-failed"];
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
  const value = await invoke("desktop_update_connection", { supports: ["service-takeover"] }) as Record<string, unknown> | null;
  if (!value || !["connecting", "available", "unavailable", "unsupported"].includes(value.state as string) ||
      (value.reason !== null && typeof value.reason !== "string") ||
      (value.terminalCommandDifferent !== undefined && typeof value.terminalCommandDifferent !== "boolean") ||
      (value.state !== "unavailable" && value.reason !== null)) throw Error("Desktop update connection unavailable");
  // A newer desktop may add reasons or error kinds; degrade them instead of losing the whole view.
  const result: DesktopUpdateConnection = {
    state: value.state as DesktopUpdateConnection["state"],
    reason: value.reason === null ? null
      : KNOWN_REASONS.includes(value.reason as string) ? value.reason as DesktopUpdateConnection["reason"] : "connection",
  };
  if (value.reason === "connection" && KNOWN_ERRORS.includes(value.error as string)) result.error = value.error as DesktopUpdateConnection["error"];
  if (value.terminalCommandDifferent !== undefined) result.terminalCommandDifferent = value.terminalCommandDifferent as boolean;
  return result;
}
