import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rpcError } from "../api/protocol";
import { CoreError, type CoreErrorCode } from "../core/errors";
import { readLines } from "./lines";
import { CANCEL_METHOD, CAPABILITY_METHODS, RESULT_CHUNK_METHOD, RESULT_CHUNK_FEATURE, resultChunkParams, chunkedResult, callMetadata } from "./protocol";
import type { CallAuthority } from "./authority";
import type { ResultStaging } from "./result-staging";

export interface SpawnSpec { argv: string[]; cwd: string; env: Record<string, string | undefined> }
export interface ProcessHooks {
  onRequest: (method: string, params: unknown, metadata?: unknown, deliver?: (result: unknown) => void) => Promise<unknown>;
  onStderr: (line: string) => void;
  onExit: (info: { code: number | null; signal: string | null }) => void;
  spawn?: typeof nodeSpawn;
}
export interface RequestOptions { authority?: CallAuthority; metadata?: unknown; signal?: AbortSignal; onProgress?: (event: unknown) => void }
type Pending = { authority?: CallAuthority; metadata?: unknown; transferStarted?: boolean; staging?: ResultStaging; dispose: () => void; onProgress?: (event: unknown) => void; method: string; resolve: (v: unknown) => void; reject: (e: CoreError) => void; timer?: ReturnType<typeof setTimeout> };
const KNOWN: ReadonlySet<string> = new Set<CoreErrorCode>(["unknown_op", "unknown_task", "invalid_input", "unknown_executor", "conflict", "not_allowed", "plugin_timeout", "plugin_unavailable", "plugin_refused", "capability_denied", "unknown_plugin", "not_found", "too_large"]);

/** One plugin child: JSON-RPC both ways on stdio, stderr to a hook, deadlines owned here. */
export class PluginProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private chunkedResults = false;
  private over = false;
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
    readLines(child.stderr, line => hooks.onStderr(line), m => hooks.onStderr(m), () => this.over);
  }

  setFeatures(features: readonly string[]): void { this.chunkedResults = features.includes(RESULT_CHUNK_FEATURE); }

  get alive(): boolean { return !this.over && this.child !== undefined; }

  private finish(info: { code: number | null; signal: string | null }, reason?: string): void {
    if (this.over) return;
    this.over = true; this.child = undefined;
    const text = reason ?? `plugin exited${info.code !== null ? ` with code ${info.code}` : info.signal ? ` on ${info.signal}` : ""}`;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.dispose(); p.reject(new CoreError("plugin_unavailable", `${p.method}: ${text}`)); }
    this.pending.clear();
    this.hooks.onExit(info);
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
    if (!this.child) throw new CoreError("plugin_unavailable", "plugin closed before capability delivery");
    this.child.stdin.write(line);
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
        if (pending?.onProgress) {
          try { pending.onProgress(params?.event); } catch { this.hooks.onStderr("progress callback failed"); }
        }
        return;
      }
      if (m.id === undefined || m.id === null) return;
      const id = m.id;
      const metadata = callMetadata.safeParse(m._meta), token = metadata.success ? metadata.data?.capabilityCall : undefined;
      const owner = token ? [...this.pending.values()].find(pending => pending.authority?.token === token
        && (pending.metadata as { capabilityCall?: unknown } | undefined)?.capabilityCall === token)?.authority : undefined;
      const budget = CAPABILITY_METHODS[m.method]?.deadlineMs ?? 0;
      const deadline = owner ? Math.min(owner.deadlineMs, budget > 0 ? Date.now() + budget : Infinity) : Infinity;
      const method = m.method;
      let delivered = false;
      const deliver = (result: unknown) => {
        if (delivered) throw new CoreError("plugin_refused", "duplicate capability delivery");
        this.sendReply(id, result, owner, deadline, method); delivered = true;
      };
      void this.hooks.onRequest(method, m.params ?? {}, m._meta, deliver)
        .then(result => { if (!delivered) deliver(result); })
        .catch(error => { if (!delivered) this.send({ id, error: rpcError(error) }); });
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
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
      if (!completion || !parsed.success || !this.chunkedResults || !p.staging || !p.authority || p.method !== "usage.read") {
        this.rejectPending(m.id, p, new CoreError("plugin_refused", "incomplete or unnegotiated chunked result")); return;
      }
      const id = m.id;
      void p.authority.exclusive(() => p.staging!.finish(parsed.data._chunkedResult.bytes)).then(value => {
        if (this.pending.get(id) !== p) return;
        this.pending.delete(id); clearTimeout(p.timer); p.dispose(); p.resolve(value);
      }, error => this.rejectPending(id, p, error instanceof CoreError ? error : new CoreError("plugin_refused", "chunked result assembly failed")));
      return;
    }
    this.pending.delete(m.id); clearTimeout(p.timer); p.dispose(); p.resolve(result);
  }

  private rejectPending(id: number, pending: Pending, error: CoreError): void {
    if (this.pending.get(id) !== pending) return;
    this.pending.delete(id); clearTimeout(pending.timer); pending.dispose(); pending.reject(error);
  }

  private async stageResult(params: unknown, metadata: unknown, deliver: (result: { bytes: number }, owner: CallAuthority) => void): Promise<void> {
    const meta = callMetadata.safeParse(metadata), token = meta.success ? meta.data?.capabilityCall : undefined;
    const owning = token ? [...this.pending.entries()].find(([, pending]) => pending.method === "usage.read"
      && pending.authority?.token === token && (pending.metadata as { capabilityCall?: unknown } | undefined)?.capabilityCall === token) : undefined;
    const parsed = resultChunkParams.safeParse(params);
    if (!parsed.success || !meta.success) {
      const failure = new CoreError("invalid_input", "malformed result chunk");
      if (owning) this.rejectPending(owning[0], owning[1], failure);
      throw failure;
    }
    const pending = this.pending.get(parsed.data.request), authority = pending?.authority;
    if (!this.chunkedResults || !pending || pending.method !== "usage.read" || !authority || token !== authority.token
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
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const cancel = (code: "plugin_timeout" | "plugin_unavailable", message: string) => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); clearTimeout(pending.timer); pending.dispose();
        this.send({ method: CANCEL_METHOD, params: { id } });
        reject(new CoreError(code, message));
      };
      const abort = () => {
        const reason = options.signal?.reason;
        cancel(reason instanceof CoreError && reason.code === "plugin_timeout" ? "plugin_timeout" : "plugin_unavailable",
          reason instanceof CoreError && reason.code === "plugin_timeout" ? reason.message : "owning plugin call ended");
      };
      const dispose = () => options.signal?.removeEventListener("abort", abort);
      const timer = deadlineMs === 0 ? undefined : setTimeout(() => cancel("plugin_timeout", `${method} passed its ${deadlineMs} ms deadline`), deadlineMs);
      this.pending.set(id, { method, authority: options.authority, metadata: options.metadata, resolve: value => resolve(value as T), reject, timer, dispose, onProgress: options.onProgress });
      options.signal?.addEventListener("abort", abort, { once: true });
      this.send({ id, method, params, ...(options.metadata ? { _meta: options.metadata } : {}) });
    });
  }

  notify(method: string, params: unknown): void { this.send({ method, params }); }

  /** SIGTERM, then SIGKILL after graceMs. Resolves once the child has exited. */
  async terminate(graceMs = 2000): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, graceMs);
    await this.exited;
    clearTimeout(killer);
  }
}
