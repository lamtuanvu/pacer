import type { Hello, ApiClient } from "../../../src/api/client-types";
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly status?: number) { super(message); this.name = "ApiError"; }
}
export type BrowserApi = Pick<ApiClient, "hello" | "snapshot" | "call">;
export function createApi(onSessionEnded: () => void = () => {}): BrowserApi {
  async function request<T>(path: string, params?: unknown): Promise<T> {
    const response = await fetch(path, { credentials: "same-origin", method: params === undefined ? "GET" : "POST", ...(params === undefined ? {} : { headers: { "X-Pacer-Client": "app", "content-type": "application/json" }, body: JSON.stringify(params) }) });
    if (response.status === 401) { onSessionEnded(); throw new ApiError("not_allowed", "Session ended. Run `pacer open`.", undefined, 401); }
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
    call: async <T>(op: string, params: unknown = {}) => (await request<{ result: T }>(`/v2/ops/${encodeURIComponent(op)}`, params)).result,
  };
}
