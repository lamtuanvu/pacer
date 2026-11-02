/** The native menu channel. Only the platform boundary reads the Tauri global. */
export interface MenuHost {
  __TAURI__?: {
    core?: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
    event?: { listen(name: string, callback: (event: { payload: unknown }) => void): Promise<() => void> };
  };
}
export function menuChannel(host: MenuHost = globalThis as MenuHost) {
  const api = host.__TAURI__;
  return { listen: api?.event?.listen, invoke: api?.core?.invoke };
}
