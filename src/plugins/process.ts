import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rpcError } from "../api/protocol";
import { CoreError, type CoreErrorCode } from "../core/errors";
import { readLines } from "./lines";
import { CANCEL_METHOD } from "./protocol";

export interface SpawnSpec { argv: string[]; cwd: string; env: Record<string, string | undefined> }
export interface ProcessHooks {
  onRequest: (method: string, params: unknown, metadata?: unknown) => Promise<unknown>;
  onStderr: (line: string) => void;
  onExit: (info: { code: number | null; signal: string | null }) => void;
  spawn?: typeof nodeSpawn;
}
export interface RequestOptions { metadata?: unknown; signal?: AbortSignal; onProgress?: (event: unknown) => void }
type Pending = { dispose: () => void; onProgress?: (event: unknown) => void; method: string; resolve: (v: unknown) => void; reject: (e: CoreError) => void; timer?: ReturnType<typeof setTimeout> };
const KNOWN: ReadonlySet<string> = new Set<CoreErrorCode>(["unknown_op", "unknown_task", "invalid_input", "unknown_executor", "conflict", "not_allowed", "plugin_timeout", "plugin_unavailable", "plugin_refused", "capability_denied", "unknown_plugin", "not_found", "too_large"]);

/** One plugin child: JSON-RPC both ways on stdio, stderr to a hook, deadlines owned here. */
export class PluginProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
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
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); } catch (e) { this.hooks.onStderr(`write failed: ${(e as Error).message}`); }
  }

  private receive(line: string): void {
    let m: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return; m = parsed as Record<string, unknown>; }
    catch { this.hooks.onStderr("ignored a malformed JSON line on stdout"); return; }
    if (m.jsonrpc !== "2.0") return;
    if (typeof m.method === "string") {
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
      void this.hooks.onRequest(m.method, m.params ?? {}, m._meta)
        .then(result => this.send({ id, result }), e => this.send({ id, error: rpcError(e) }));
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id); clearTimeout(p.timer); p.dispose();
    if (m.error) {
      const err = m.error as { message?: string; data?: { code?: string; hint?: string } };
      const code = err.data?.code && KNOWN.has(err.data.code) ? (err.data.code as CoreErrorCode) : "plugin_unavailable";
      p.reject(new CoreError(code, err.message ?? "plugin error", err.data?.hint));
    } else p.resolve(m.result);
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
      const abort = () => cancel("plugin_unavailable", "owning plugin call ended");
      const dispose = () => options.signal?.removeEventListener("abort", abort);
      const timer = deadlineMs === 0 ? undefined : setTimeout(() => cancel("plugin_timeout", `${method} passed its ${deadlineMs} ms deadline`), deadlineMs);
      this.pending.set(id, { method, resolve: value => resolve(value as T), reject, timer, dispose, onProgress: options.onProgress });
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
