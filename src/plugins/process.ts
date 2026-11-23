import {pluginMetadata} from "./policy-protocol";
import {plannerPreparedResultAllowed} from "./planner-resources";
import { scheduleDeadline } from "../deadline";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pluginRpcError as rpcError } from "./errors";
import { CoreError, type CoreErrorCode } from "../core/errors";
import { MAX_LINE_BYTES, readLines } from "./lines";
import { CANCEL_METHOD, CAPABILITY_METHODS, RESULT_CHUNK_METHOD, RESULT_CHUNK_FEATURE, STREAM_ACK_METHOD, STREAM_INPUT_METHOD, STREAM_INPUT_ACK_METHOD, streamAckParams, streamProgressEvent, streamInputFrame, streamInputAckParams, resultChunkParams, chunkedResult } from "./protocol";
import type { CallAuthority } from "./authority";
import { armDuplexInput, clearDuplexInput, consumeDuplexInputReceipt } from "./capability-duplex";
import type { ResultStaging } from "./result-staging";

export interface SpawnSpec { argv: string[]; cwd: string; env: Record<string, string | undefined> }
export interface CapabilityTransport {
  readonly features: readonly string[];
  requestFits(params: unknown): boolean;
  resultFits(result: unknown): boolean;
}
export interface ProcessHooks {
  onRequest: (method: string, params: unknown, metadata?: unknown, deliver?: (result: unknown) => void, transport?: CapabilityTransport) => Promise<unknown>;
  validateReadOwner?: (token:string,method:string)=>void;
  onDisconnect?:()=>void;
  onStderr: (line: string) => void;
  onExit: (info: { code: number | null; signal: string | null }) => void;
  spawn?: typeof nodeSpawn;
}
export interface StreamProgress { streamId: string; consume: (bytes: Buffer) => Promise<void> }
export interface RequestOptions { prepareInput?: (fits:(params:unknown)=>boolean)=>unknown; authority?: CallAuthority; metadata?: unknown; signal?: AbortSignal; onProgress?: (event: unknown) => void; stream?: StreamProgress }
type StreamPending = StreamProgress & { nextSeq: number; inputSeq: number;
  outstanding?: { seq: number; done: Promise<void>; cancelDeadline: () => void };
  input?: { seq: number; resolve: () => void; reject: (error: CoreError) => void; cancelDeadline: () => void } };
type Pending = { authority?: CallAuthority; metadata?: unknown; transferStarted?: boolean; staging?: ResultStaging; dispose: () => void; onProgress?: (event: unknown) => void; stream?: StreamPending; method: string; resolve: (v: unknown) => void; reject: (e: CoreError) => void; cancelDeadline?: () => void };
const KNOWN: ReadonlySet<string> = new Set<CoreErrorCode>(["unknown_op", "unknown_task", "invalid_input", "unknown_executor", "conflict", "not_allowed", "plugin_timeout", "plugin_unavailable", "plugin_refused", "capability_denied", "unknown_plugin", "not_found", "too_large"]);

/** One plugin child: JSON-RPC both ways on stdio, stderr to a hook, deadlines owned here. */
export class PluginProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private chunkedResults = false;
  private features: readonly string[] = Object.freeze([]);
  private over = false;
  private exitReported = false;
  readonly pid: number | undefined;
  readonly exited: Promise<void>;

  constructor(readonly spec: SpawnSpec, private readonly hooks: ProcessHooks) {
    let settle!: () => void;
    this.exited = new Promise<void>(r => { settle = r; });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (hooks.spawn ?? nodeSpawn)(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      queueMicrotask(() => { this.finish({ code: null, signal: null }, String(e)); settle(); });
      return;
    }
    this.child = child; this.pid = child.pid;
    const done = (info: { code: number | null; signal: string | null }) => { this.finish(info); settle(); };
    child.once("exit", (code, signal) => done({ code, signal }));
    child.once("error", e => { hooks.onStderr(`spawn error: ${e.message}`); done({ code: null, signal: null }); });
    child.stdin.on("error", e => { hooks.onStderr(`stdin error: ${e.message}`); child.kill("SIGTERM"); });
    readLines(child.stdout, line => this.receive(line), m => hooks.onStderr(m), () => this.over);
    child.stdout.once("end",()=>{
      if(this.over)return;
      this.finish({code:null,signal:null},"plugin stdout closed",false);
      hooks.onDisconnect?.();
      try {child.kill("SIGTERM");}catch{}
      const killer=setTimeout(()=>{try{child.kill("SIGKILL");}catch{}},2000);
      killer.unref();child.once("exit",()=>clearTimeout(killer));
    });
    readLines(child.stderr, line => hooks.onStderr(line), m => hooks.onStderr(m), () => this.over);
  }

  setFeatures(features: readonly string[]): void {
    this.features = Object.freeze([...features]);
    this.chunkedResults = this.features.includes(RESULT_CHUNK_FEATURE);
  }

  supports(feature:string):boolean {return this.features.includes(feature);}

  get alive(): boolean { return !this.over && this.child !== undefined; }

  private finish(info: { code: number | null; signal: string | null }, reason?: string, reportExit=true): void {
    if(this.over){if(reportExit&&!this.exitReported){this.exitReported=true;this.hooks.onExit(info);}return;}
    this.over = true; this.child = undefined;
    const text = reason ?? `plugin exited${info.code !== null ? ` with code ${info.code}` : info.signal ? ` on ${info.signal}` : ""}`;
    for (const p of this.pending.values()) { p.cancelDeadline?.(); p.dispose();
      p.stream?.input?.cancelDeadline();
      if (p.authority && p.stream?.input) clearDuplexInput(p.authority, p.stream.input.seq);
      p.stream?.input?.reject(new CoreError("plugin_unavailable", "stream input owner ended"));
      p.reject(new CoreError("plugin_unavailable", `${p.method}: ${text}`)); }
    this.pending.clear();
    if(reportExit){this.exitReported=true;this.hooks.onExit(info);}
  }

  private send(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child) return;
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); }
    catch (error) { this.hooks.onStderr(`write failed: ${(error as Error).message}`); }
  }

  /** Delivery stays inside the scoped operation's window and its captured clock. */
  private sendReply(id: unknown, result: unknown, owner?: CallAuthority, deadline = Infinity, method = "capability"): void {
    const guard = () => {
      owner?.assertActive();
      if (Date.now() >= deadline) {
        const failure = new CoreError("plugin_timeout", `${method} passed its capability deadline`);
        if (owner) void owner.revoke(failure).catch(() => {});
        throw failure;
      }
    };
    guard();
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
    guard();
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new CoreError("too_large", "capability reply exceeds its transport envelope");
    if (!this.child) throw new CoreError("plugin_unavailable", "plugin closed before capability delivery");
    this.child.stdin.write(line);
  }

  private canStage(pending:Pending):boolean {
    return pending.method==="usage.read"||(this.features.includes("plannerInstallTransactions")&&plannerPreparedResultAllowed(pending.authority,pending.method));
  }

  private receive(line: string): void {
    let m: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return; m = parsed as Record<string, unknown>; }
    catch { this.hooks.onStderr("ignored a malformed JSON line on stdout"); return; }
    if (m.jsonrpc !== "2.0") return;
    if (typeof m.method === "string") {
      if (m.method === RESULT_CHUNK_METHOD) {
        if (m.id === undefined || m.id === null) return;
        const id = m.id;
        void this.stageResult(m.params, m._meta, (result, owner) => this.sendReply(id, result, owner, owner.deadlineMs, RESULT_CHUNK_METHOD))
          .catch(error => this.send({ id, error: rpcError(error) }));
        return;
      }
      if (m.method === "$/progress") {
        const params = m.params as { id?: unknown; event?: unknown } | undefined;
        const pending = typeof params?.id === "number" ? this.pending.get(params.id) : undefined;
        if (!pending?.stream && params?.event && typeof params.event === "object" && !Array.isArray(params.event)) {
          const streamId = (params.event as { streamId?: unknown }).streamId;
          const owning = [...this.pending.entries()].find(([, candidate]) => candidate.stream !== undefined && candidate.stream.streamId === streamId);
          if (owning) {
            this.rejectPending(owning[0], owning[1], new CoreError("plugin_refused", "stream progress has the wrong request ID"));
            return;
          }
        }
        if (pending?.stream) {
          this.receiveStreamProgress(params!.id as number, pending, params?.event);
          return;
        }
        if (pending?.onProgress) {
          try { pending.onProgress(params?.event); } catch { this.hooks.onStderr("progress callback failed"); }
        }
        return;
      }
      if (m.method === STREAM_ACK_METHOD) {
        if (m.id === undefined || m.id === null) return;
        void this.ackStreamProgress(m.id, m.params, m._meta)
          .catch(error => this.send({ id: m.id, error: rpcError(error) }));
        return;
      }
      if (m.method === STREAM_INPUT_ACK_METHOD) {
        if (m.id === undefined || m.id === null) return;
        try { this.ackStreamInput(m.id, m.params, m._meta); }
        catch (error) { this.send({ id: m.id, error: rpcError(error) }); }
        return;
      }
      if (m.id === undefined || m.id === null) return;
      const id = m.id;
      const metadata = pluginMetadata.safeParse(m._meta);
      if (!metadata.success) {
        this.send({id,error:rpcError(new CoreError("capability_denied","read owner metadata is unavailable or invalid"))});return;
      }
      const readToken=metadata.data&&"readOwner" in metadata.data?metadata.data.readOwner:undefined;
      const guardRead=()=>{
        if(readToken===undefined)return;
        if(!this.features.includes("policyObservations")||!this.hooks.validateReadOwner)throw new CoreError("capability_denied","read owner transport unavailable");
        this.hooks.validateReadOwner(readToken as string,m.method as string);
      };
      try {guardRead();} catch(error) {this.send({id,error:rpcError(error)});return;}
      const token = typeof metadata.data?.capabilityCall === "string" ? metadata.data.capabilityCall : undefined;
      const owner = token ? [...this.pending.values()].find(pending => pending.authority?.token === token
        && (pending.metadata as { capabilityCall?: unknown } | undefined)?.capabilityCall === token)?.authority : undefined;
      if(token&&!owner) {
        this.send({id,error:rpcError(new CoreError("capability_denied","capability token has no active pending request"))});return;
      }
      const budget = CAPABILITY_METHODS[m.method]?.deadlineMs ?? 0;
      const deadline = owner ? Math.min(owner.deadlineMs, budget > 0 ? Date.now() + budget : Infinity) : budget > 0 ? Date.now() + budget : Infinity;
      const method = m.method;
      let delivered = false;
      const deliver = (result: unknown) => {
        if (delivered) throw new CoreError("plugin_refused", "duplicate capability delivery");
        guardRead();this.sendReply(id, result, owner, deadline, method); delivered = true;
      };
      const fits = (message: Record<string, unknown>): boolean => {
        try { return Buffer.byteLength(`${JSON.stringify(message)}\n`, "utf8") <= MAX_LINE_BYTES; }
        catch { return false; }
      };
      const transport: CapabilityTransport = Object.freeze({
        features: this.features,
        requestFits: (params: unknown) => fits({ ...m, params }),
        resultFits: (result: unknown) => fits({ jsonrpc: "2.0", id, result }),
      });
      void this.hooks.onRequest(method, m.params ?? {}, m._meta, deliver, transport)
        .then(result => { if (!delivered) deliver(result); })
        .catch(error => { if (!delivered) this.send({ id, error: rpcError(error) }); });
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    if (p.stream?.outstanding || p.stream?.input) {
      this.rejectPending(m.id, p, new CoreError("plugin_refused", "stream result arrived before acknowledgement"));
      return;
    }
    if (m.error) {
      const err = m.error as { message?: string; data?: { code?: string; hint?: string } };
      const code = err.data?.code && KNOWN.has(err.data.code) ? (err.data.code as CoreErrorCode) : "plugin_unavailable";
      this.rejectPending(m.id, p, new CoreError(code, err.message ?? "plugin error", err.data?.hint));
      return;
    }
    const result = m.result;
    const completion = result && typeof result === "object" && !Array.isArray(result)
      && Object.keys(result).length === 1 && Object.hasOwn(result, "_chunkedResult");
    if (completion || p.transferStarted) {
      const parsed = chunkedResult.safeParse(result);
      if (!completion || !parsed.success || !this.chunkedResults || !p.staging || !p.authority || !this.canStage(p)) {
        this.rejectPending(m.id, p, new CoreError("plugin_refused", "incomplete or unnegotiated chunked result")); return;
      }
      const id = m.id;
      void p.authority.exclusive(() => p.staging!.finish(parsed.data._chunkedResult.bytes)).then(value => {
        if (this.pending.get(id) !== p) return;
        this.pending.delete(id); p.cancelDeadline?.(); p.dispose(); p.resolve(value);
      }, error => this.rejectPending(id, p, error instanceof CoreError ? error : new CoreError("plugin_refused", "chunked result assembly failed")));
      return;
    }
    this.pending.delete(m.id); p.cancelDeadline?.(); p.stream?.outstanding?.cancelDeadline(); p.dispose(); p.resolve(result);
  }

  private receiveStreamProgress(id: number, pending: Pending, raw: unknown): void {
    const stream = pending.stream!;
    const frame = streamProgressEvent.safeParse(raw);
    const valid = frame.success && frame.data.streamId === stream.streamId &&
      frame.data.seq === stream.nextSeq && !stream.outstanding;
    if (!valid) {
      this.rejectPending(id, pending, new CoreError("plugin_refused", "invalid or unacknowledged stream progress"));
      return;
    }
    const bytes = Buffer.from(frame.data.base64, "base64");
    if (!bytes.length || bytes.length > 65_536 || bytes.toString("base64") !== frame.data.base64) {
      this.rejectPending(id, pending, new CoreError("plugin_refused", "stream progress exceeds the bounded frame"));
      return;
    }
    const timeout = new CoreError("plugin_timeout", "stream progress was not acknowledged");
    let cancelDeadline!: () => void;
    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => { this.rejectPending(id, pending, timeout); reject(timeout); }, 5000);
      timer.unref();
      cancelDeadline = () => clearTimeout(timer);
    });
    const done = Promise.race([Promise.resolve().then(() => stream.consume(bytes)), deadline]);
    void done.catch(error => this.rejectPending(id, pending,
      error instanceof CoreError ? error : new CoreError("plugin_unavailable", "stream consumer failed")));
    stream.outstanding = { seq: frame.data.seq, done, cancelDeadline };
  }

  private async ackStreamProgress(id: unknown, raw: unknown, metadata: unknown): Promise<void> {
    const parsed = streamAckParams.safeParse(raw);
    const request = parsed.success ? parsed.data.request : undefined;
    const pending = request === undefined ? undefined : this.pending.get(request);
    const stream = pending?.stream;
    const token = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).capabilityCall : undefined;
    if (!pending || !stream || !pending.authority || !stream.outstanding ||
      !parsed.success || parsed.data.streamId !== stream.streamId ||
      parsed.data.seq !== stream.outstanding.seq || token !== pending.authority.token ||
      (pending.metadata as { capabilityCall?: unknown } | undefined)?.capabilityCall !== token) {
      if (pending?.stream) this.rejectPending(request as number, pending,
        new CoreError("plugin_refused", "stream acknowledgement failed owner verification"));
      throw new CoreError("capability_denied", "stream acknowledgement has no active owning frame");
    }
    await stream.outstanding.done;
    if (this.pending.get(request as number) !== pending || pending.authority.signal.aborted)
      throw new CoreError("capability_denied", "stream acknowledgement owner ended");
    stream.outstanding.cancelDeadline();
    stream.outstanding = undefined;
    stream.nextSeq++;
    this.sendReply(id, { seq: parsed.data.seq }, pending.authority, Date.now() + 5000, STREAM_ACK_METHOD);
  }

  private ackStreamInput(id: unknown, raw: unknown, metadata: unknown): void {
    const parsed = streamInputAckParams.safeParse(raw);
    const pending = parsed.success ? this.pending.get(parsed.data.request) : undefined;
    const stream = pending?.stream, input = stream?.input;
    const token = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).capabilityCall : undefined;
    if (!parsed.success || !pending || !stream || !input || !pending.authority ||
      parsed.data.streamId !== stream.streamId || parsed.data.seq !== input.seq ||
      token !== pending.authority.token ||
      (pending.metadata as { capabilityCall?: unknown } | undefined)?.capabilityCall !== token) {
      if (parsed.success && pending?.stream) this.rejectPending(parsed.data.request, pending,
        new CoreError("plugin_refused", "stream input acknowledgement failed owner verification"));
      throw new CoreError("capability_denied", "stream input acknowledgement has no active owner");
    }
    try { consumeDuplexInputReceipt(pending.authority, input.seq); }
    catch (error) {
      this.rejectPending(parsed.data.request, pending, new CoreError("plugin_refused", "stream input had no broker write receipt"));
      throw error;
    }
    this.sendReply(id, { seq: parsed.data.seq }, pending.authority, Date.now() + 5000, STREAM_INPUT_ACK_METHOD);
    input.cancelDeadline();
    stream.input = undefined;
    stream.inputSeq++;
    input.resolve();
  }

  /** Readiness is true only after the exact owned request is registered. */
  hasPendingStream(streamId: string): boolean {
    return this.alive && [...this.pending.values()].some(pending =>
      pending.method === "hostRunner.stream" && pending.stream?.streamId === streamId &&
      !!pending.authority && !pending.authority.signal.aborted);
  }

  /** Push one bounded viewer frame to the exact pending stream, then await its SSH write receipt. */
  sendStreamInput(streamId: string, bytes: Buffer): Promise<void> {
    const owning = [...this.pending.entries()].find(([, pending]) => pending.stream?.streamId === streamId);
    if (!owning || !this.alive) return Promise.reject(new CoreError("capability_denied", "stream input has no active owner"));
    const [request, pending] = owning, stream = pending.stream!;
    try { pending.authority?.assertActive(); }
    catch (error) { return Promise.reject(error); }
    if (stream.input || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 65_536)
      return Promise.reject(new CoreError("conflict", "stream input frame is unavailable or over its bound"));
    const frame = { request, streamId, seq: stream.inputSeq, base64: bytes.toString("base64") };
    if (!streamInputFrame.safeParse(frame).success)
      return Promise.reject(new CoreError("invalid_input", "invalid stream input frame"));
    try { armDuplexInput(pending.authority!, stream.inputSeq, bytes); }
    catch (error) { return Promise.reject(error); }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.rejectPending(request, pending,
        new CoreError("plugin_timeout", "stream input was not acknowledged")), 5000);
      timer.unref();
      stream.input = { seq: stream.inputSeq, resolve, reject, cancelDeadline: () => clearTimeout(timer) };
      this.send({ method: STREAM_INPUT_METHOD, params: frame });
    });
  }

  private rejectPending(id: number, pending: Pending, error: CoreError): void {
    if (this.pending.get(id) !== pending) return;
    // Keep a pending frame's five-second timer alive so an in-flight consumer
    // and acknowledgement waiter also settle after the parent call is gone.
    this.pending.delete(id); pending.cancelDeadline?.(); pending.dispose();
    if (pending.stream?.input) { pending.stream.input.cancelDeadline();
      if (pending.authority) clearDuplexInput(pending.authority, pending.stream.input.seq);
      pending.stream.input.reject(error); pending.stream.input = undefined; }
    pending.reject(error);
  }

  private async stageResult(params: unknown, metadata: unknown, deliver: (result: { bytes: number }, owner: CallAuthority) => void): Promise<void> {
    const meta = pluginMetadata.safeParse(metadata), token = meta.success && typeof meta.data?.capabilityCall === "string" ? meta.data.capabilityCall : undefined;
    const owning = token ? [...this.pending.entries()].find(([, pending]) => this.canStage(pending)
      && pending.authority?.token === token && (pending.metadata as { capabilityCall?: unknown } | undefined)?.capabilityCall === token) : undefined;
    const parsed = resultChunkParams.safeParse(params);
    if (!parsed.success || !meta.success) {
      const failure = new CoreError("invalid_input", "malformed result chunk");
      if (owning) this.rejectPending(owning[0], owning[1], failure);
      throw failure;
    }
    const pending = this.pending.get(parsed.data.request), authority = pending?.authority;
    if (!this.chunkedResults || !pending || !this.canStage(pending) || !authority || token !== authority.token
      || (pending.metadata as { capabilityCall?: unknown } | undefined)?.capabilityCall !== token) {
      const failure = new CoreError("capability_denied", "result chunk does not belong to an active negotiated request");
      if (owning) this.rejectPending(owning[0], owning[1], failure);
      throw failure;
    }
    // Publish transfer admission before dynamic import or filesystem awaits. A peer
    // cannot race an ordinary result past an admitted but not-yet-created staging file.
    pending.transferStarted = true;
    return authority.exclusive(async () => {
      if (this.pending.get(parsed.data.request) !== pending) throw new CoreError("capability_denied", "owning result request ended");
      if (!pending.staging) {
        const { ResultStaging } = await import("./result-staging");
        authority.assertActive();
        pending.staging = new ResultStaging(authority);
      }
      const result = await pending.staging.stage(parsed.data.offset, parsed.data.base64);
      if (this.pending.get(parsed.data.request) !== pending) throw new CoreError("capability_denied", "owning result request ended");
      deliver(result, authority);
    }).catch(error => {
      this.rejectPending(parsed.data.request, pending, error instanceof CoreError ? error : new CoreError("plugin_refused", "result chunk transfer failed"));
      throw error;
    });
  }

  request<T>(method: string, params: unknown, deadlineMs: number, options: RequestOptions = {}): Promise<T> {
    if (!this.alive) return Promise.reject(new CoreError("plugin_unavailable", `${method}: plugin is not running`));
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) return Promise.reject(new CoreError("invalid_input", "request deadline must be non-negative"));
    if (options.signal?.aborted) return Promise.reject(new CoreError("plugin_unavailable", "owning plugin call ended"));
    if (options.stream && (method !== "hostRunner.stream" || !options.authority ||
      (options.metadata as { capabilityCall?: unknown } | undefined)?.capabilityCall !== options.authority.token ||
      (params as { streamId?: unknown } | undefined)?.streamId !== options.stream.streamId ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(options.stream.streamId)))
      return Promise.reject(new CoreError("capability_denied", "stream progress requires an owning host stream"));
    const id = this.nextId++;
    const frame=(value:unknown)=>`${JSON.stringify({jsonrpc:"2.0",id,method,params:value,...(options.metadata?{_meta:options.metadata}:{})})}\n`;
    try {
      if(options.prepareInput)params=options.prepareInput(value=>Buffer.byteLength(frame(value))<=MAX_LINE_BYTES);
      if(Buffer.byteLength(frame(params))>MAX_LINE_BYTES)return Promise.reject(new CoreError("too_large","plugin request exceeds complete frame limit"));
    } catch(error) {return Promise.reject(error);}
    return new Promise<T>((resolve, reject) => {
      const cancel = (code: "plugin_timeout" | "plugin_unavailable", message: string) => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); pending.cancelDeadline?.(); pending.dispose();
        if (pending.stream?.input) { pending.stream.input.cancelDeadline();
          if (pending.authority) clearDuplexInput(pending.authority, pending.stream.input.seq);
          pending.stream.input.reject(new CoreError(code, message)); pending.stream.input = undefined; }
        this.send({ method: CANCEL_METHOD, params: { id } });
        reject(new CoreError(code, message));
      };
      const abort = () => {
        const reason = options.signal?.reason;
        cancel(reason instanceof CoreError && reason.code === "plugin_timeout" ? "plugin_timeout" : "plugin_unavailable",
          reason instanceof CoreError && reason.code === "plugin_timeout" ? reason.message : "owning plugin call ended");
      };
      const dispose = () => options.signal?.removeEventListener("abort", abort);
      const cancelDeadline = deadlineMs === 0 ? undefined : scheduleDeadline(Date.now() + deadlineMs, () => cancel("plugin_timeout", `${method} passed its ${deadlineMs} ms deadline`));
      this.pending.set(id, { method, authority: options.authority, metadata: options.metadata, resolve: value => resolve(value as T), reject, cancelDeadline, dispose, onProgress: options.onProgress,
        stream: options.stream ? { ...options.stream, nextSeq: 0, inputSeq: 0 } : undefined });
      options.signal?.addEventListener("abort", abort, { once: true });
      this.send({ id, method, params, ...(options.metadata ? { _meta: options.metadata } : {}) });
    });
  }

  notify(method: string, params: unknown): void { this.send({ method, params }); }

  /** Event queue owns the bounded reservation until this exact stream flushes. */
  notifyBounded(method:string,params:unknown,guard:()=>void):Promise<void> {
    guard();const child=this.child;
    if(!child||this.over)return Promise.reject(new CoreError("plugin_unavailable","event transport closed"));
    const line=JSON.stringify({jsonrpc:"2.0",method,params})+"\n";
    if(Buffer.byteLength(line)>MAX_LINE_BYTES)return Promise.reject(new CoreError("too_large","event notification exceeds transport frame"));
    return new Promise((resolve,reject)=>{
      let finished=false;
      const finish=(error?:unknown)=>{if(finished)return;finished=true;clearTimeout(timer);child.off("exit",exit);if(error)reject(error);else resolve();};
      const exit=()=>finish(new CoreError("plugin_unavailable","event transport closed"));
      const timer=setTimeout(()=>finish(new CoreError("plugin_timeout","event delivery stalled")),2000);
      child.once("exit",exit);
      try {guard();child.stdin.write(line,error=>{if(error){finish(error);return;}try {guard();finish();}catch(error){finish(error);}});}catch(error){finish(error);}
    });
  }

  /** SIGTERM, then SIGKILL after graceMs. Resolves once the child has exited. */
  async terminate(graceMs = 2000): Promise<void> {
    const child = this.child;
    if (!child) {if(this.over)await this.exited;return;}
    child.kill("SIGTERM");
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, graceMs);
    await this.exited;
    clearTimeout(killer);
  }
}
