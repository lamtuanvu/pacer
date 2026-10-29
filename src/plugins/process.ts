import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rpcError } from "../api/protocol";
import { CoreError, type CoreErrorCode } from "../core/errors";
import { readLines } from "./lines";
import { CANCEL_METHOD } from "./protocol";

export interface SpawnSpec { argv: string[]; cwd: string; env: Record<string, string | undefined> }
export interface ProcessHooks {
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onNotification?: (method: string, params: unknown) => void;
  onStderr: (line: string) => void;
  onExit: (info: { code: number | null; signal: string | null }) => void;
  spawn?: typeof nodeSpawn;
}
type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: CoreError) => void; timer: ReturnType<typeof setTimeout> };
const KNOWN: ReadonlySet<string> = new Set<CoreErrorCode>(["unknown_op", "unknown_task", "invalid_input", "unknown_executor", "conflict", "not_allowed", "plugin_timeout", "plugin_unavailable", "plugin_refused", "capability_denied", "unknown_plugin"]);

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
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new CoreError("plugin_unavailable", `${p.method}: ${text}`)); }
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
      if (m.id === undefined || m.id === null) { try { this.hooks.onNotification?.(m.method, m.params ?? {}); } catch (e) { this.hooks.onStderr(`notification ${m.method} failed: ${(e as Error).message}`); } return; }
      const id = m.id;
      void this.hooks.onRequest(m.method, m.params ?? {})
        .then(result => this.send({ id, result }), e => this.send({ id, error: rpcError(e) }));
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) {
      const err = m.error as { message?: string; data?: { code?: string; hint?: string } };
      const code = err.data?.code && KNOWN.has(err.data.code) ? (err.data.code as CoreErrorCode) : "plugin_unavailable";
      p.reject(new CoreError(code, err.message ?? "plugin error", err.data?.hint));
    } else p.resolve(m.result);
  }

  request<T>(method: string, params: unknown, deadlineMs: number, signal?: AbortSignal): Promise<T> {
    if (!this.alive) return Promise.reject(new CoreError("plugin_unavailable", `${method}: plugin is not running`));
    if (signal?.aborted) return Promise.reject(new CoreError("plugin_unavailable", `${method} was cancelled`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ method: CANCEL_METHOD, params: { id } });
        reject(new CoreError("plugin_timeout", `${method} passed its ${deadlineMs} ms deadline`));
      }, deadlineMs);
      this.pending.set(id, { method, resolve: v => resolve(v as T), reject, timer });
      // An aborted call is cancelled in the plugin too, so it stops spending.
      signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        this.send({ method: CANCEL_METHOD, params: { id } });
        reject(new CoreError("plugin_unavailable", `${method} was cancelled`));
      }, { once: true });
      this.send({ id, method, params });
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
