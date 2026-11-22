import { platform } from "../platform";
import type { Hello, ApiClient } from "../../../src/api/client-types";
import { TerminalActionRequests } from "./terminal-action-request";
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly status?: number, readonly data?: unknown) { super(message); this.name = "ApiError"; }
}
/** Only the desktop shell exposes this bridge; browsers keep their sign-in guidance. */
export function reportSessionEnded(): void {
  platform.reportSessionEnded();
}
/** Reads may still succeed over HTTP when the event transport is unavailable. */
export function readOperation(op: string): boolean {
  return /\.(get|list|status|summary|log|diff|session|preview|explain|show|search|tree|events|wait|models|analytics|dependencies|retry_options)$/.test(op)
    || ['setup.check', 'plugin.ui.render', 'dispatch.enforcement', 'liveness.status', 'routing.route', 'msg.policy', 'session.file.read', 'assistant.turn', 'assistant.history'].includes(op);
}
export type BrowserApi = Pick<ApiClient, "hello" | "snapshot" | "call"> & { setConnected?: (connected: boolean) => void };
export function createApi(onSessionEnded: () => void = () => {}): BrowserApi {
  const terminalRequests=new TerminalActionRequests(()=>crypto.randomUUID());
  let connected = true;
  // This window's client instance: two windows contend for an interactive lane's driving lease (task.send).
  const instance = crypto.randomUUID();
  let negotiation: Promise<Hello> | undefined;
  async function request<T>(path: string, params?: unknown): Promise<T> {
    const response = await platform.request(path, { credentials: "same-origin", method: params === undefined ? "GET" : "POST", ...(params === undefined ? {} : { headers: { "X-Pacer-Client": "app", "X-Pacer-Client-Instance": instance, "content-type": "application/json" }, body: JSON.stringify(params) }) });
    if (response.status === 401) { reportSessionEnded(); onSessionEnded(); throw new ApiError("not_allowed", "Session ended. Run `pacer open`.", undefined, 401); }
    if (!response.ok) {
      const text = await response.text();
      let error: { code: string; message: string; hint?: string; data?: unknown } | undefined;
      try { error = JSON.parse(text).error; } catch { /* pre-routing HTTP failure */ }
      throw new ApiError(error?.code ?? "internal", error?.message ?? `pacer serve: HTTP ${response.status}`, error?.hint, response.status, error?.data);
    }
    return response.json() as Promise<T>;
  }
  function validateHello(value: Hello): Hello {
    if (!value || !/^\d+\.\d+\.\d+$/.test(value.protocol) || !Array.isArray(value.ops) || !Array.isArray(value.events)) throw new ApiError("internal", "The service returned an invalid protocol response.");
    return value;
  }
  async function negotiate(): Promise<Hello> {
    let hello: Hello;
    try {
      hello = validateHello(await request<Hello>("/v3/hello"));
    } catch (error) {
      // The app speaks only protocol 3. A service that does not answer with a
      // v3 hello (404/426 or a transport failure) is not a compatible service.
      if (error instanceof ApiError && (error.status === 404 || error.status === 426)) {
        throw new ApiError("unsupported_protocol", "This service protocol is not supported.", undefined, error.status);
      }
      throw error;
    }
    if (hello.protocol.split(".")[0] !== "3") {
      throw new ApiError("unsupported_protocol", "This service protocol is not supported.");
    }
    return hello;
  }
  function select(): Promise<Hello> {
    if (!negotiation) negotiation = negotiate().finally(() => { negotiation = undefined; });
    return negotiation;
  }
  return {
    setConnected(value) { connected = value; },
    hello: async () => select(),
    snapshot: async () => { await select(); return request<Awaited<ReturnType<ApiClient["snapshot"]>>>("/v3/snapshot"); },
    call: async <T>(op: string, params: unknown = {}): Promise<T> => {
      if (!connected && !readOperation(op)) throw new ApiError("offline", "pacer is offline");
      await select();
      if (!connected && !readOperation(op)) throw new ApiError("offline", "pacer is offline");
      const prepared=terminalRequests.prepare(op,params);
      params=prepared.params;
      try {
        const result = (await request<{ result: T }>(`/v3/ops/${encodeURIComponent(op)}`, params)).result;
        terminalRequests.finish(prepared.key);
        const terminalId = (result as {terminalId?:unknown} | null)?.terminalId;
        if (typeof terminalId === "string" && /^[0-9a-f-]{36}$/.test(terminalId)) location.hash = `#/terminal/${terminalId}`;
        return result;
      } catch (error) {
        terminalRequests.finish(prepared.key,error instanceof ApiError?error.status??0:0);
        throw error;
      }
    },
  };
}
