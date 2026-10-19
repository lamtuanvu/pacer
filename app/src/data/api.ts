import type { Hello, ApiClient } from "../../../src/api/client-types";
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly status?: number) { super(message); this.name = "ApiError"; }
}
/** Only the desktop shell exposes this bridge; browsers keep their sign-in guidance. */
export function reportSessionEnded(): void {
  const host = globalThis as typeof globalThis & { __TAURI__?: { core?: { invoke: (command: string) => Promise<unknown> } } };
  void host.__TAURI__?.core?.invoke("session_expired").catch(() => { /* shell may already be navigating to recovery */ });
}
/** Ops whose /v2 result is frozen to an older shape; the app needs the current one. */
const V3_OPS = new Set(["setup.check"]);
export type BrowserApi = Pick<ApiClient, "hello" | "snapshot" | "call">;
export function createApi(onSessionEnded: () => void = () => {}): BrowserApi {
  async function request<T>(path: string, params?: unknown): Promise<T> {
    const response = await fetch(path, { credentials: "same-origin", method: params === undefined ? "GET" : "POST", ...(params === undefined ? {} : { headers: { "X-Pacer-Client": "app", "content-type": "application/json" }, body: JSON.stringify(params) }) });
    if (response.status === 401) { reportSessionEnded(); onSessionEnded(); throw new ApiError("not_allowed", "Session ended. Run `pacer open`.", undefined, 401); }
    if (!response.ok) {
      const text = await response.text();
      let error: { code: string; message: string; hint?: string } | undefined;
      try { error = JSON.parse(text).error; } catch { /* pre-routing HTTP failure */ }
      throw new ApiError(error?.code ?? "internal", error?.message ?? `pacer serve: HTTP ${response.status}`, error?.hint, response.status);
    }
    return response.json() as Promise<T>;
  }
  return {
    hello: () => request<Hello>("/v2/hello"), snapshot: () => request<Awaited<ReturnType<ApiClient["snapshot"]>>>("/v2/snapshot"),
    call: async <T>(op: string, params: unknown = {}) => (await request<{ result: T }>(`/${V3_OPS.has(op) ? "v3" : "v2"}/ops/${encodeURIComponent(op)}`, params)).result,
  };
}
