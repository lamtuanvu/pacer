export type { AgentIdentityInput, AgentIdentityPlan, AttachmentMetadata, AttachmentRef, AgentVersion, AgentSessionCapabilities, AgentDelegationControl, AgentSessionPrepare, AgentSessionLaunch, AgentAttachmentInput, AgentAttachmentDelivery } from "./agent-session";

export interface PluginManifest {
  id: string; version: string; publisher: string; host: string;
  contributes?: Record<string, Record<string, unknown>>;
  capabilities?: { name: string; scopes?: string[] }[];
  entry?: string; reentrant?: boolean; tier?: "free" | "commercial";
}
export interface Hello { protocol: string; pacer: string; manifest: PluginManifest; config: Record<string, unknown>; grants: string[] }
export interface HostClient {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  log(level: "debug" | "info" | "warn" | "error", message: string): Promise<void>;
  config(): Promise<Record<string, unknown>>;
}
export type Handler = (params: unknown, host: HostClient, signal: AbortSignal) => unknown | Promise<unknown>;
export interface ServeOptions {
  manifest: PluginManifest;
  handlers?: Record<string, Handler>;
  /** Extension points to claim at handshake; defaults to the manifest's `contributes` keys. */
  contributes?: string[];
  input?: AsyncIterable<string>;
  write?: (line: string) => void;
  now?: () => number;
}

/** An error with a code the host can map (invalid_input, not_allowed, …). */
export class PluginError extends Error {
  constructor(public readonly code: string, message: string, public readonly hint?: string) { super(message); this.name = "PluginError"; }
}

export const PROTOCOL = "1.0.0";
const HELLO = "plugin.hello", CANCEL = "$/cancel";
type Json = Record<string, unknown>;

/** Newline-delimited text from a byte stream, for stdin. */
export async function* stdinLines(stream: AsyncIterable<Buffer | string> = process.stdin): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of stream) {
    rest += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let i: number;
    while ((i = rest.indexOf("\n")) !== -1) { yield rest.slice(0, i); rest = rest.slice(i + 1); }
  }
  if (rest) yield rest;
}

/** Serve the plugin until the input ends. Resolves after every in-flight handler settles. */
export async function serve(o: ServeOptions): Promise<void> {
  const write = o.write ?? ((line: string) => { process.stdout.write(line); });
  const now = o.now ?? (() => Date.now() / 1000);
  const send = (m: Json) => write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const inflight = new Map<string | number, AbortController>();
  const tasks = new Set<Promise<void>>();
  let nextId = 1, startedAt: number | null = null, hello: Hello | null = null;

  const host: HostClient = {
    call<T>(method: string, params: unknown = {}) {
      const id = `p${nextId++}`;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: v => resolve(v as T), reject });
        send({ id, method, params });
      });
    },
    async log(level, message) { await host.call("capability.log", { level, message }); },
    async config() { return (await host.call<{ config: Record<string, unknown> }>("capability.config.get", {})).config; },
  };
  const builtin: Record<string, Handler> = {
    "diagnostic.ping": () => ({ ok: true, uptimeS: startedAt === null ? 0 : Math.max(0, now() - startedAt) }),
  };
  const errorBody = (e: unknown) => e instanceof PluginError
    ? { code: -32000, message: e.message, data: { code: e.code, ...(e.hint ? { hint: e.hint } : {}) } }
    : { code: -32000, message: e instanceof Error ? e.message : String(e), data: { code: "internal" } };

  const handle = async (line: string) => {
    let m: unknown;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== "object" || Array.isArray(m)) return;
    const r = m as Json;
    if (r.jsonrpc !== "2.0") return;
    if (typeof r.method === "string") {
      const id = r.id as string | number | undefined;
      if (r.method === CANCEL) { const p = r.params as Json | undefined; inflight.get(p?.id as string | number)?.abort(); return; }
      if (id === undefined || id === null) return;
      if (r.method === HELLO) {
        hello = r.params as Hello; startedAt = now();
        send({ id, result: { protocol: PROTOCOL, id: o.manifest.id, version: o.manifest.version, contributes: o.contributes ?? Object.keys(o.manifest.contributes ?? {}) } });
        return;
      }
      if (!hello) { send({ id, error: { code: -32000, message: "plugin.hello must come first", data: { code: "plugin_refused" } } }); return; }
      const handler = o.handlers?.[r.method] ?? builtin[r.method];
      if (!handler) { send({ id, error: { code: -32601, message: `unknown method ${r.method}`, data: { code: "unknown_op" } } }); return; }
      const controller = new AbortController(); inflight.set(id, controller);
      try { send({ id, result: await handler(r.params ?? {}, host, controller.signal) }); }
      catch (e) { send({ id, error: errorBody(e) }); }
      finally { inflight.delete(id); }
      return;
    }
    if (typeof r.id !== "string") return;
    const p = pending.get(r.id); if (!p) return;
    pending.delete(r.id);
    if (r.error) { const err = r.error as { message?: string; data?: { code?: string; hint?: string } }; p.reject(new PluginError(err.data?.code ?? "internal", err.message ?? "host error", err.data?.hint)); }
    else p.resolve(r.result);
  };

  try {
    for await (const line of o.input ?? stdinLines()) { const t = handle(line); tasks.add(t); void t.finally(() => tasks.delete(t)); }
  } finally {
    for (const p of pending.values()) p.reject(new PluginError("plugin_unavailable", "host closed the connection"));
    pending.clear();
    for (const c of inflight.values()) c.abort();
    await Promise.all(tasks);
  }
}
