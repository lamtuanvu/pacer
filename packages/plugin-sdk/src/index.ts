export * from "./ui";
import {EventCallbacks,EVENT_TYPES,isPolicyEvent} from "./event-callbacks";
export {POLICY_OBSERVATIONS_FEATURE} from "./policy";
import {POLICY_OBSERVATIONS_FEATURE,type ObservationClient,type PolicyEvent} from "./policy";
export type {PolicyBeforeParams,PolicyDecision,PolicyVerdict,PolicyEventType,PolicyTaskState,PolicyTask,PolicyEvent,ObservationClient} from "./policy";
import { createFileSystem } from "./fs";
import { createHttp, type Request as HttpRequest, type Response as HttpResponse } from "./http";
import { createHosts } from "./hosts";
export type { HostFetchInput } from "./hosts";
export type { AgentIdentityInput, AgentIdentityPlan, AttachmentMetadata, AttachmentRef, AgentVersion, AgentSessionCapabilities, AgentDelegationControl, AgentSessionPrepare, AgentSessionLaunch, AgentAttachmentInput, AgentAttachmentDelivery } from "./agent-session";
export type {HostRunnerScript,HostRunnerSession,HostRunnerRequest,HostRunnerRunInput,HostRunnerRunResult,HostRunnerFetchResult} from "./host-runner";
export { executorAvailableHandler } from "./executor";
export type { ExecutorAvailableInput, ExecutorAvailableResult, ExecutorAvailableHandler } from "./executor";

export interface PluginManifest {
  id: string; version: string; publisher: string; host: string;
  contributes?: Record<string, Record<string, unknown>>;
  capabilities?: { name: string; scopes?: string[] }[];
  entry?: string; reentrant?: boolean; tier?: "free" | "commercial";
}
export interface Hello { features?: string[]; protocol: string; pacer: string; manifest: PluginManifest; config: Record<string, unknown>; grants: string[] }
export interface HostClient extends ObservationClient {
  fs: ReturnType<typeof createFileSystem>;
  /** Present in the current SDK runtime; optional for older mock/SDK clients. */
  hosts?: ReturnType<typeof createHosts>;
  http(request:HttpRequest):Promise<HttpResponse>;
  secrets: { present(ref:string):Promise<boolean> };
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Present only for an owned hostRunner.stream request. Waits for host consumption. */
  streamProgress?: (streamId: string, seq: number, bytes: Uint8Array) => Promise<void>;
  /** Present only for an owned hostRunner.stream request. One frame until ack. */
  streamInput?: { next(): Promise<{ bytes: Uint8Array; ack(): Promise<void> }> };
  /** Send a bounded event during the owning executor.run call. */
  progress?(event: unknown): void;
  log(level: "debug" | "info" | "warn" | "error", message: string): Promise<void>;
  config(): Promise<Record<string, unknown>>;
  /** Sign `payload` with the machine key under a purpose declared in the manifest scopes for `identity.sign` (host >= 1.4.0). */
  identitySign(purpose: string, payload: Uint8Array): Promise<{ signature: Uint8Array; machineId: string }>;
  /** Ask the host to re-render one ui surface, or all of them. Fire and forget; the host coalesces. */
  invalidate(id?: string): void;
}
export type Handler = (params: unknown, host: HostClient, signal: AbortSignal) => unknown | Promise<unknown>;
/** `pairing.start` params (host >= 1.5.0). Values come from the LAN: untrusted, sanitized by the host; never build URLs or commands from them. */
export interface PairingStart { discoveryId: string; name: string; hints: string }
export interface PairingStartResult { accepted: boolean }
/** The `pairing.start` handler, typed. Spread it into `handlers`; the manifest contributes `pairing` and declares `net.p2p`. */
export function pairingStart(handler: (params: PairingStart, host: HostClient, signal: AbortSignal) => PairingStartResult | Promise<PairingStartResult>): Record<"pairing.start", Handler> {
  return { "pairing.start": (params, host, signal) => handler(params as PairingStart, host, signal) };
}
export interface ServeOptions {
  manifest: PluginManifest;
  /** Future API notifications begin after the first owned diagnostic/policy call subscribes. */
  onEvent?: (event:PolicyEvent,host:ObservationClient)=>void|Promise<void>;
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

export const PROTOCOL = "1.10.0";
const HELLO = "plugin.hello", CANCEL = "$/cancel";
type Json = Record<string, unknown>;

function streamDuplexDeadline(method: string, params: unknown, owner?: { method: string; id: number }): number | undefined {
  if (owner?.method !== "hostRunner.stream") return undefined;
  if (method === "capability.process.duplex.open") return 10_000;
  if (method === "capability.process.duplex.close") return 5_000;
  if (method !== "capability.process.duplex.read" && method !== "capability.process.duplex.write") return undefined;
  const requested = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>).timeoutMs : undefined;
  return typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested + 5_000, 65_000) : 65_000;
}

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
  const send = (m: Json) => {
    const line = `${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`;
    if (Buffer.byteLength(line) > 1048576) throw new PluginError("too_large", "plugin complete frame exceeds limit");
    write(line);
  };
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; dispose: () => void }>();
  const inflight = new Map<string | number, AbortController>();
  type InputFrame = { seq: number; bytes: Uint8Array; delivered: boolean };
  const streamInputs = new Map<number, { streamId: string; nextSeq: number; frame?: InputFrame;
    waiter?: { resolve: () => void; reject: (error: Error) => void } }>();
  const tasks = new Set<Promise<void>>();
  let nextId = 1, startedAt: number | null = null, hello: Hello | null = null;

  let negotiatedFeatures = new Set<string>();
  let readOwner:string|undefined;
  let subscribing:Promise<void>|undefined;
  const observationScope=new AbortController();
  let failObservations!:(error:unknown)=>void;
  const observationFailure=new Promise<never>((_resolve,reject)=>{failObservations=reject;});
  void observationFailure.catch(()=>{});
  const callbacks=new EventCallbacks(async event=>{
    if(!readOwner||observationScope.signal.aborted)return;
    const host=hostFor({readOwner},observationScope.signal);
    const client:ObservationClient={tasks:host.tasks,events:host.events,log:host.log,config:host.config};
    await o.onEvent?.(event,client);
  },()=>{observationScope.abort();readOwner=undefined;failObservations(new PluginError("plugin_unavailable","event callback queue cannot deliver reset"));});


  function hostFor(metadata?: unknown, signal?: AbortSignal, request?: { method: string; id: number }): HostClient {
    const candidate=metadata&&typeof metadata==="object"&&!Array.isArray(metadata)?metadata as Json:undefined;
    if(candidate&&candidate.capabilityCall!==undefined&&candidate.readOwner!==undefined)throw new PluginError("capability_denied","mixed authority metadata");
    const meta=candidate&&(typeof candidate.capabilityCall==="string"||typeof candidate.readOwner==="string")?candidate:undefined;
    const observed=typeof meta?.readOwner==="string";
    const call = <T>(method: string, params: unknown = {}, cleanup = false, ambient = false): Promise<T> => {
      if (!cleanup && signal?.aborted) return Promise.reject(new PluginError("plugin_unavailable", "owning plugin call ended"));
      const id = `p${nextId++}`;
      const envelope = { jsonrpc: "2.0", id, method, params, ...(!ambient&&meta ? { _meta: meta } : {}) };
      if (Buffer.byteLength(JSON.stringify(envelope)+"\n") > 1048576) return Promise.reject(new PluginError("invalid_input", "HTTP complete frame exceeds limit"));
      return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => {
          const waiting = pending.get(id); if (!waiting) return;
          pending.delete(id); waiting.dispose();
          reject(new PluginError("plugin_unavailable", "owning plugin call ended"));
        };
        const dispose = () => { signal?.removeEventListener("abort", cancel); if (timer) clearTimeout(timer); };
        pending.set(id, { resolve: value => resolve(value as T), reject, dispose });
        if (!cleanup) signal?.addEventListener("abort", cancel, { once: true });
        const deadline = streamDuplexDeadline(method, params, request);
        if (deadline !== undefined) {
          timer = setTimeout(() => {
            const waiting = pending.get(id); if (!waiting) return;
            pending.delete(id); waiting.dispose();
            reject(new PluginError("plugin_timeout", `${method} response passed its ${deadline} ms deadline`));
          }, deadline);
          timer.unref();
        }
        send({ id, method, params, ...(!ambient&&meta ? { _meta: meta } : {}) });
      });
    };
    const observations=()=>{if(!negotiatedFeatures.has(POLICY_OBSERVATIONS_FEATURE))throw new PluginError("plugin_unavailable","policy observation transport not negotiated");};
    return {
      tasks: {
        async read(id){observations();return (await call<{task:import("./policy").PolicyTask}>("capability.tasks.read",{id})).task;},
        async list(options={}){observations();return (await call<{tasks:import("./policy").PolicyTask[]}>("capability.tasks.list",options)).tasks;},
      },
      events: {async subscribe(types){observations();const result=await call<{ok:true;readOwner:string}>("capability.events.subscribe",{types});if(result.ok!==true||typeof result.readOwner!=="string"||!result.readOwner.length||result.readOwner.length>256)throw new PluginError("plugin_refused","invalid read owner acknowledgement");readOwner=result.readOwner;}},
      call,
      progress(event) {
        if (request?.method !== "executor.run" || signal?.aborted)
          throw new PluginError("capability_denied", "executor progress requires an active run");
        send({ method: "$/progress", params: { id: request.id, event } });
      },
      ...(request?.method === "hostRunner.stream" && meta?.capabilityCall ? { streamProgress: async (streamId: string, seq: number, bytes: Uint8Array) => {
        if (signal?.aborted || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(streamId) ||
          !Number.isSafeInteger(seq) || seq < 0 || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 65_536)
          throw new PluginError("capability_denied", "invalid owned stream progress frame");
        send({ method: "$/progress", params: { id: request.id, event: { streamId, seq, base64: Buffer.from(bytes).toString("base64") } } });
        const ack = await call<{ seq: number }>("$/streamAck", { request: request.id, streamId, seq });
        if (ack?.seq !== seq) throw new PluginError("plugin_refused", "invalid stream progress acknowledgement");
      } } : {}),
      ...(request?.method === "hostRunner.stream" && meta?.capabilityCall ? { streamInput: { next: async () => {
        const state = streamInputs.get(request.id);
        if (!state || signal?.aborted || state.frame?.delivered || state.waiter)
          throw new PluginError("capability_denied", "stream input owner is unavailable");
        if (!state.frame) await new Promise<void>((resolve, reject) => {
          const abort = () => { state.waiter = undefined; reject(new PluginError("plugin_unavailable", "stream input owner ended")); };
          state.waiter = { resolve: () => { signal?.removeEventListener("abort", abort); resolve(); },
            reject: error => { signal?.removeEventListener("abort", abort); reject(error); } };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
        const frame = state.frame;
        if (!frame || frame.delivered || signal?.aborted) throw new PluginError("capability_denied", "stream input frame is unavailable");
        frame.delivered = true;
        return { bytes: frame.bytes, ack: async () => {
          if (signal?.aborted || state.frame !== frame) throw new PluginError("capability_denied", "stream input frame retired");
          const ack = await call<{ seq: number }>("$/streamInputAck", { request: request.id,
            streamId: state.streamId, seq: frame.seq });
          if (ack?.seq !== frame.seq) throw new PluginError("plugin_refused", "invalid stream input acknowledgement");
          state.frame = undefined;
          state.nextSeq++;
        } };
      } } } : {}),
      fs: createFileSystem({call,cleanupCall:(method,params)=>call(method,params,true),signal,
        negotiated:()=>negotiatedFeatures.has("fileWriteChunks"),
        fits:(method,params)=>Buffer.byteLength(JSON.stringify({jsonrpc:"2.0",id:`p${nextId}`,method,params,...(meta?{_meta:meta}:{})})+"\n")<=1048576}),
      hosts: createHosts(call),
      http: createHttp({call, cleanupCall:(method,params)=>call(method,params,true), signal,
        negotiated:()=>negotiatedFeatures.has("httpBodyChunks"),
        fits:(method,params)=>Buffer.byteLength(JSON.stringify({jsonrpc:"2.0",id:`p${nextId}`,method,params,...(meta?{_meta:meta}:{})})+"\n")<=1048576}),
      secrets: { async present(ref) { return (await call<{present:boolean}>("capability.secrets.check",{ref})).present; } },
      async log(level, message) { await call("capability.log", { level, message },false,observed); },
      async config() { return (await call<{ config: Record<string, unknown> }>("capability.config.get", {},false,observed)).config; },
      invalidate(id) { send({ method: "ui.invalidate", params: id === undefined ? {} : { id } }); },
      async identitySign(purpose, payload) {
        const r = await call<{ signature: string; machineId: string }>("capability.identity.sign", { purpose, payload: Buffer.from(payload).toString("base64") });
        return { signature: new Uint8Array(Buffer.from(r.signature, "base64")), machineId: r.machineId };
      },
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
    if(r.method==="$/event"&&r.id===undefined) {
      if(negotiatedFeatures.has(POLICY_OBSERVATIONS_FEATURE)&&readOwner&&isPolicyEvent(r.params))callbacks.push(r.params);
      return;
    }
    if (r.method === "$/streamInput" && r.id === undefined) {
      const value = r.params && typeof r.params === "object" && !Array.isArray(r.params) ? r.params as Json : {};
      const state = typeof value.request === "number" ? streamInputs.get(value.request) : undefined;
      if (!state) return;
      const bad = Object.keys(value).length !== 4 || value.streamId !== state.streamId ||
        value.seq !== state.nextSeq || state.frame !== undefined ||
        typeof value.base64 !== "string" || value.base64.length < 4 || value.base64.length > 87_384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64);
      const bytes = bad ? Buffer.alloc(0) : Buffer.from(value.base64 as string, "base64");
      if (bad || !bytes.length || bytes.length > 65_536 || bytes.toString("base64") !== value.base64) {
        inflight.get(value.request as number)?.abort();
        state.waiter?.reject(new PluginError("plugin_refused", "invalid stream input frame"));
        state.waiter = undefined;
        return;
      }
      state.frame = { seq: value.seq as number, bytes, delivered: false };
      state.waiter?.resolve(); state.waiter = undefined;
      return;
    }

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
            || feature === "fileWriteChunks" && minor >= 4
            || feature === "plannerInstallTransactions" && minor >= 4
            || feature === POLICY_OBSERVATIONS_FEATURE && minor >= 6) : [];
        negotiatedFeatures = new Set(features);
        send({ id, result: { protocol: PROTOCOL, id: o.manifest.id, version: o.manifest.version, contributes: o.contributes ?? Object.keys(o.manifest.contributes ?? {}), ...(features.length ? { features } : {}) } });
        return;
      }
      if (!hello) { send({ id, error: { code: -32000, message: "plugin.hello must come first", data: { code: "plugin_refused" } } }); return; }
      const handler = o.handlers?.[r.method] ?? builtin[r.method];
      if (!handler) { send({ id, error: { code: -32601, message: `unknown method ${r.method}`, data: { code: "unknown_op" } } }); return; }
      const controller = new AbortController(); inflight.set(id, controller);
      if (r.method === "hostRunner.stream" && typeof id === "number" &&
        r.params && typeof r.params === "object" && !Array.isArray(r.params) &&
        typeof (r.params as Json).streamId === "string" &&
        r._meta && typeof r._meta === "object" && typeof (r._meta as Json).capabilityCall === "string")
        streamInputs.set(id, { streamId: (r.params as Json).streamId as string, nextSeq: 0 });
      try {
        const host = hostFor(r._meta, controller.signal,
          (r.method === "hostRunner.stream" || r.method === "executor.run") && typeof id === "number"
            ? { method: r.method, id } : undefined);
        const result = await handler(r.params ?? {}, host, controller.signal);
        if(o.onEvent&&["diagnostic.ping","policy.before"].includes(r.method)&&!readOwner) {
          if(!host||!r._meta||typeof (r._meta as Json).capabilityCall!=="string")throw new PluginError("capability_denied","observations need an actual owning host call");
          if(!subscribing)subscribing=host.events.subscribe([...EVENT_TYPES]).finally(()=>{subscribing=undefined;});
          await subscribing;
        }
        const scoped = r.method === "usage.read" || !!(r._meta && typeof r._meta === "object"
          && typeof (r._meta as Json).capabilityCall === "string");
        if (scoped && controller.signal.aborted) throw new PluginError("plugin_unavailable", "owning plugin call ended");
        const chunked = (r.method === "usage.read" || ((r.method === "planner.install" || r.method === "planner.uninstall") && negotiatedFeatures.has("plannerInstallTransactions"))) && typeof id === "number" && hello.protocol.startsWith("1.")
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
      finally { inflight.delete(id); controller.abort();
        if (typeof id === "number") { const state = streamInputs.get(id); state?.waiter?.reject(new PluginError("plugin_unavailable", "stream input owner ended")); streamInputs.delete(id); } }
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
    const input=(o.input??stdinLines())[Symbol.asyncIterator]();
    try {for(;;){const next=await Promise.race([input.next(),observationFailure]);if(next.done)break;const t=handle(next.value);tasks.add(t);void t.then(()=>tasks.delete(t),()=>tasks.delete(t));}}
    finally {const returned=input.return?.();if(returned)void Promise.resolve(returned).catch(()=>{}); }
  } finally {
    callbacks.close();observationScope.abort();readOwner=undefined;
    for (const p of pending.values()) { p.dispose(); p.reject(new PluginError("plugin_unavailable", "host closed the connection")); }
    pending.clear();
    for (const c of inflight.values()) c.abort();
    await Promise.all(tasks);
  }
}

export { createUsageReaderIO } from "./usage";
export type { UsageKind, UsageSource, UsageWindow, UsageReading, RunResult, EvidenceScope, Evidence, SpendingSignals, AccountEvidence,
  FileInfo, Cursor, Cached, ReaderIO, ReaderContext, MeteredConfig } from "./usage";
