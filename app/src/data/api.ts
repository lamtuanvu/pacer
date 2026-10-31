import type { Hello, ApiClient } from "../../../src/api/client-types";
import { TerminalActionRequests } from "./terminal-action-request";
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly status?: number, readonly data?: unknown) { super(message); this.name = "ApiError"; }
}
/** Only the desktop shell exposes this bridge; browsers keep their sign-in guidance. */
export function reportSessionEnded(): void {
  const host = globalThis as typeof globalThis & { __TAURI__?: { core?: { invoke: (command: string) => Promise<unknown> } } };
  void host.__TAURI__?.core?.invoke("session_expired").catch(() => { /* shell may already be navigating to recovery */ });
}
/** Ops that are v3-only, or whose /v2 result is frozen to an older shape. */
const V3_OPS = new Set(["account.usage.check","dispatch.config.get", "runner.settings.get", "runner.settings.save", "task.list", "doctor.run", "project.strategy.list", "project.strategy.get", "project.strategy.set", "project.strategy.remove", "setup.check", "service.install", "onboarding.try", "onboarding.skip", "limits.refresh", "terminal.list", "terminal.create", "terminal.rename", "terminal.close", "msg.log", "msg.send", "msg.read", "msg.policy", "liveness.status"]);
export type BrowserApi = Pick<ApiClient, "hello" | "snapshot" | "call"> & { setConnected?: (connected: boolean) => void };
export function createApi(onSessionEnded: () => void = () => {}): BrowserApi {
  const terminalRequests=new TerminalActionRequests(()=>crypto.randomUUID());
  let connected = true;
  // This window's client instance: two windows contend for an interactive lane's driving lease (task.send).
  const instance = crypto.randomUUID();
  let version: 2 | 3 | undefined;
  let negotiation: Promise<Hello> | undefined;
  async function request<T>(path: string, params?: unknown): Promise<T> {
    const response = await fetch(path, { credentials: "same-origin", method: params === undefined ? "GET" : "POST", ...(params === undefined ? {} : { headers: { "X-Pacer-Client": "app", "X-Pacer-Client-Instance": instance, "content-type": "application/json" }, body: JSON.stringify(params) }) });
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
  const legacyHello = (hello: Hello): Hello => ({ ...hello, ops: hello.ops.filter(op => !op.startsWith("desktop.update.")), events: hello.events.filter(event => event !== "desktop.update") });
  async function negotiate(): Promise<Hello> {
    try {
      const hello = validateHello(await request<Hello>("/v3/hello"));
      if (hello.protocol.split(".")[0] === "3") { version = 3; return hello; }
      // A well-formed unsupported major is explicit incompatibility, not a transport failure.
    } catch (error) {
      if (!(error instanceof ApiError) || ![404, 426].includes(error.status ?? 0)) throw error;
    }
    const hello = validateHello(await request<Hello>("/v2/hello"));
    if (hello.protocol.split(".")[0] !== "2") throw new ApiError("internal", "This service protocol is not supported.");
    version = 2;
    return legacyHello(hello);
  }
  function select(): Promise<Hello> {
    if (!negotiation) negotiation = negotiate().finally(() => { negotiation = undefined; });
    return negotiation;
  }
  return {
    setConnected(value) { connected = value; },
    hello: async () => { if (!version) return select(); const hello = validateHello(await request<Hello>(`/v${version}/hello`)); return version === 2 ? legacyHello(hello) : hello; },
    snapshot: async () => { if (!version) await select(); return request<Awaited<ReturnType<ApiClient["snapshot"]>>>(`/v${version}/snapshot`); },
    call: async <T>(op: string, params: unknown = {}): Promise<T> => {
      if (!connected) throw new ApiError("offline", "pacer is offline");
      if (!version) await select();
      if (!connected) throw new ApiError("offline", "pacer is offline");
      if (version === 2 && op.startsWith("desktop.update.")) throw new ApiError("unknown_op", "Desktop updates require a newer service.");
      const prepared=terminalRequests.prepare(op,params);
      params=prepared.params;
      try {
        const result = (await request<{ result: T }>(`/v${version === 3 || V3_OPS.has(op) ? 3 : 2}/ops/${encodeURIComponent(op)}`, params)).result;
        terminalRequests.finish(prepared.key);
        const terminalId = (result as {terminalId?:unknown} | null)?.terminalId;
        if (typeof terminalId === "string" && /^[0-9a-f-]{36}$/.test(terminalId)) location.hash = `#/terminal/${terminalId}`;
        return result;
      } catch (error) {
        terminalRequests.finish(prepared.key,error instanceof ApiError?error.status??0:0);
        if (op !== "task.list" || !(error instanceof ApiError) || error.status !== 404) throw error;
        // A filtered v2 list is a cursor page; limit alone returns legacy summaries.
        const filtered = { states: ["queued", "running", "done", "partial", "failed", "limit", "stopped", "needs_input"], ...(params as Record<string, unknown>) };
        return (await request<{ result: T }>("/v2/ops/task.list", filtered)).result;
      }
    },
  };
}
