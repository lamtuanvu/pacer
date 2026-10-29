export interface TrayHost {
  __TAURI__?: { core?: { invoke: Invoke }; tauri?: { invoke: Invoke }; invoke?: Invoke };
  location: { assign(url: string): void };
}
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export function appHref(route: string): string { return `/app/#${route.replace(/^#/, "") || "/"}`; }
/** Only these four commands cross the desktop boundary. A browser needs no shell. */
export function createTrayIpc(host: TrayHost | undefined = typeof window === "undefined" ? undefined : window as unknown as TrayHost) {
  const invoke = host?.__TAURI__?.core?.invoke ?? host?.__TAURI__?.tauri?.invoke ?? host?.__TAURI__?.invoke;
  return {
    open: async (route: string) => {
      if (invoke) await invoke("tray_open", { route });
      else host?.location.assign(appHref(route));
    },
    resize: async (height: number) => { if (invoke) await invoke("tray_resize", { height: Math.max(1, Math.min(560, Math.ceil(height))) }); },
    hide: async () => { if (invoke) await invoke("tray_hide"); },
    quit: async () => { if (invoke) await invoke("app_quit"); },
    desktop: !!invoke,
  };
}
export type TrayIpc = ReturnType<typeof createTrayIpc>;
