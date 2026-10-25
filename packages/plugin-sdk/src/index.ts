import { createFileSystem } from "./fs";
import { createHttp, type Request as HttpRequest, type Response as HttpResponse } from "./http";
export type { AttachmentMetadata, AttachmentRef, AgentVersion, AgentSessionCapabilities, AgentSessionPrepare, AgentSessionLaunch, AgentAttachmentInput, AgentAttachmentDelivery } from "./agent-session";

export interface PluginManifest {
  id: string; version: string; publisher: string; host: string;
  contributes?: Record<string, Record<string, unknown>>;
  capabilities?: { name: string; scopes?: string[] }[];
  entry?: string; reentrant?: boolean; tier?: "free" | "commercial";
}
export interface Hello { features?: string[]; protocol: string; pacer: string; manifest: PluginManifest; config: Record<string, unknown>; grants: string[] }
export interface HostClient {
  fs: ReturnType<typeof createFileSystem>;
  http(request:HttpRequest):Promise<HttpResponse>;
  secrets: { present(ref:string):Promise<boolean> };
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

type ErrorReason = "credential_reflection";
const errorReason = (code: unknown, reason: unknown): ErrorReason | undefined =>
  code === "capability_denied" && reason === "credential_reflection" ? reason : undefined;

/** An error with a code the host can map (invalid_input, not_allowed, …). */
export class PluginError extends Error {
  readonly reason?: ErrorReason;
  constructor(public readonly code: string, message: string, public readonly hint?: string, reason?: ErrorReason) {
    super(message);
    this.name = "PluginError";
    this.reason = errorReason(code, reason);
  }
}

export const PROTOCOL = "1.4.0";
const HELLO = "plugin.hello", CANCEL = "$/cancel";
type Json = Record<string, unknown>;

/** Newline-delimited text from a byte stream, for stdin. */
export async function* stdinLines(stream: AsyncIterable<Buffer | string> = process.stdin): AsyncGenerator<string> {
  let rest = "";
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  for await (const chunk of stream) {
    // Preserve scalar boundaries across byte chunks and the old raw BOM semantics.
    rest += typeof chunk === "string" ? decoder.decode() + chunk : decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = rest.indexOf("\n")) !== -1) { yield rest.slice(0, i); rest = rest.slice(i + 1); }
  }
  rest += decoder.decode();
  if (rest) yield rest;
}

/** Serve the plugin until the input ends. Resolves after every in-flight handler settles. */
export async function serve(o: ServeOptions): Promise<void> {
  const write = o.write ?? ((line: string) => { process.stdout.write(line); });
  const now = o.now ?? (() => Date.now() / 1000);
  const send = (m: Json) => write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; dispose: () => void }>();
  const inflight = new Map<string | number, AbortController>();
  const tasks = new Set<Promise<void>>();
  let nextId = 1, startedAt: number | null = null, hello: Hello | null = null;

  let negotiatedFeatures = new Set<string>();

  function hostFor(metadata?: unknown, signal?: AbortSignal): HostClient {
    const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      && typeof (metadata as Json).capabilityCall === "string" ? metadata : undefined;
    const call = <T>(method: string, params: unknown = {}, cleanup = false): Promise<T> => {
      if (!cleanup && signal?.aborted) return Promise.reject(new PluginError("plugin_unavailable", "owning plugin call ended"));
      const id = `p${nextId++}`;
      const envelope = { jsonrpc: "2.0", id, method, params, ...(meta ? { _meta: meta } : {}) };
      if (Buffer.byteLength(JSON.stringify(envelope)+"\n") > 1048576) return Promise.reject(new PluginError("invalid_input", "HTTP complete frame exceeds limit"));
      return new Promise<T>((resolve, reject) => {
        const cancel = () => {
          const waiting = pending.get(id); if (!waiting) return;
          pending.delete(id); waiting.dispose();
          reject(new PluginError("plugin_unavailable", "owning plugin call ended"));
        };
        const dispose = () => signal?.removeEventListener("abort", cancel);
        pending.set(id, { resolve: value => resolve(value as T), reject, dispose });
        if (!cleanup) signal?.addEventListener("abort", cancel, { once: true });
        send({ id, method, params, ...(meta ? { _meta: meta } : {}) });
      });
    };
    return {
      call,
      fs: createFileSystem({call,cleanupCall:(method,params)=>call(method,params,true),signal,
        negotiated:()=>negotiatedFeatures.has("fileWriteChunks"),
        fits:(method,params)=>Buffer.byteLength(JSON.stringify({jsonrpc:"2.0",id:`p${nextId}`,method,params,...(meta?{_meta:meta}:{})})+"\n")<=1048576}),
      http: createHttp({call, cleanupCall:(method,params)=>call(method,params,true), signal,
        negotiated:()=>negotiatedFeatures.has("httpBodyChunks"),
        fits:(method,params)=>Buffer.byteLength(JSON.stringify({jsonrpc:"2.0",id:`p${nextId}`,method,params,...(meta?{_meta:meta}:{})})+"\n")<=1048576}),
      secrets: { async present(ref) { return (await call<{present:boolean}>("capability.secrets.resolve",{ref})).present; } },
      async log(level, message) { await call("capability.log", { level, message }); },
      async config() { return (await call<{ config: Record<string, unknown> }>("capability.config.get", {})).config; },
    };
  }
  const builtin: Record<string, Handler> = {
    "diagnostic.ping": () => ({ ok: true, uptimeS: startedAt === null ? 0 : Math.max(0, now() - startedAt) }),
  };
  const errorBody = (e: unknown) => e instanceof PluginError
    ? { code: -32000, message: e.message, data: {
      code: e.code,
      ...(e.hint ? { hint: e.hint } : {}),
      ...(errorReason(e.code, e.reason) ? { reason: e.reason } : {}),
    } }
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
        const [major, minor] = hello.protocol.split(".").map(Number);
        const offered = Array.isArray(hello.features) ? hello.features : [];
        const features = major === 1 && Number.isInteger(minor)
          ? offered.filter(feature => feature === "chunkedResults" && minor >= 1
            || feature === "httpBodyChunks" && minor >= 2
            || feature === "fileWriteChunks" && minor >= 4) : [];
        negotiatedFeatures = new Set(features);
        send({ id, result: { protocol: PROTOCOL, id: o.manifest.id, version: o.manifest.version, contributes: o.contributes ?? Object.keys(o.manifest.contributes ?? {}), ...(features.length ? { features } : {}) } });
        return;
      }
      if (!hello) { send({ id, error: { code: -32000, message: "plugin.hello must come first", data: { code: "plugin_refused" } } }); return; }
      const handler = o.handlers?.[r.method] ?? builtin[r.method];
      if (!handler) { send({ id, error: { code: -32601, message: `unknown method ${r.method}`, data: { code: "unknown_op" } } }); return; }
      const controller = new AbortController(); inflight.set(id, controller);
      try {
        const host = hostFor(r._meta, controller.signal);
        const result = await handler(r.params ?? {}, host, controller.signal);
        const scoped = r.method === "usage.read" || !!(r._meta && typeof r._meta === "object"
          && typeof (r._meta as Json).capabilityCall === "string");
        if (scoped && controller.signal.aborted) throw new PluginError("plugin_unavailable", "owning plugin call ended");
        const chunked = r.method === "usage.read" && typeof id === "number" && hello.protocol.startsWith("1.")
          && Number(hello.protocol.split(".")[1]) >= 1 && Array.isArray(hello.features) && hello.features.includes("chunkedResults");
        const bytes = chunked ? Buffer.from(JSON.stringify(result)) : undefined;
        if (bytes && bytes.length > 768 * 1024) {
          for (let offset = 0; offset < bytes.length; offset += 262144) {
            if (controller.signal.aborted) throw new PluginError("plugin_unavailable", "owning plugin call ended");
            const part = bytes.subarray(offset, offset + 262144);
            const ack = await host.call<{ bytes: number }>("$/resultChunk", { request: id, offset, base64: part.toString("base64") });
            if (ack.bytes !== offset + part.length) throw new PluginError("plugin_refused", "incomplete result chunk acknowledgement");
          }
          if (controller.signal.aborted) throw new PluginError("plugin_unavailable", "owning plugin call ended");
          send({ id, result: { _chunkedResult: { bytes: bytes.length } } });
        } else send({ id, result });
      }
      catch (e) { send({ id, error: errorBody(e) }); }
      finally { inflight.delete(id); controller.abort(); }
      return;
    }
    if (typeof r.id !== "string") return;
    const p = pending.get(r.id); if (!p) return;
    pending.delete(r.id); p.dispose();
    if (r.error) {
      const err = r.error as { message?: string; data?: { code?: string; hint?: string; reason?: unknown } };
      p.reject(new PluginError(
        err.data?.code ?? "internal", err.message ?? "host error", err.data?.hint,
        errorReason(err.data?.code, err.data?.reason),
      ));
    } else p.resolve(r.result);
  };

  try {
    for await (const line of o.input ?? stdinLines()) { const t = handle(line); tasks.add(t); void t.finally(() => tasks.delete(t)); }
  } finally {
    for (const p of pending.values()) { p.dispose(); p.reject(new PluginError("plugin_unavailable", "host closed the connection")); }
    pending.clear();
    for (const c of inflight.values()) c.abort();
    await Promise.all(tasks);
  }
}

export { createUsageReaderIO } from "./usage";
export type { UsageKind, UsageSource, UsageWindow, UsageReading, RunResult, EvidenceScope, Evidence, SpendingSignals, AccountEvidence,
  FileInfo, Cursor, Cached, ReaderIO, ReaderContext, MeteredConfig } from "./usage";
