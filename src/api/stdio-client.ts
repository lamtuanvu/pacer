import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ApiError, type ApiClient, type Hello } from "./client-types";
import type { ApiEvent } from "./protocol";

const MAX_LINE_BYTES = 1024 * 1024;
type Pending = { resolve: (result: unknown) => void; reject: (error: ApiError) => void };
type Subscription = { since: number; onEvent: (event: ApiEvent) => void };

/** One headless pacer process, shared by calls and a resumable event stream. */
export class StdioClient implements ApiClient {
  readonly kind = "stdio";
  child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Set<Subscription>();
  private nextId = 1;
  private closed = false;
  private backoffMs = 1000;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly argv: string[],
    private readonly env: Record<string, string | undefined>,
    private readonly o: { log?: (m: string) => void; maxBackoffMs?: number; spawn?: typeof spawn } = {},
  ) {
    if (!argv.length) throw new Error("pacer argv must not be empty");
    this.start();
  }

  private rejectPending(): void {
    for (const pending of this.pending.values()) pending.reject(new ApiError("internal", "pacer api exited"));
    this.pending.clear();
  }

  private restart(): void {
    if (this.closed) return;
    const delay = Math.min(this.backoffMs, this.o.maxBackoffMs ?? 30_000);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, delay);
  }

  private start(): void {
    if (this.closed) return;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.o.spawn ?? spawn)(this.argv[0]!, [...this.argv.slice(1), "api", "--stdio"], {
        env: this.env, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      this.o.log?.(String(e));
      this.restart();
      return;
    }
    this.child = child;
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      this.child = undefined;
      this.rejectPending();
      this.restart();
    };
    child.once("exit", finish);
    child.once("error", (e) => { this.o.log?.(e.message); finish(); });
    child.stdin.on("error", (e) => { this.o.log?.(e.message); child.kill("SIGTERM"); finish(); });

    // Bound incomplete lines too, so a child cannot grow the buffer indefinitely.
    const lines = (stream: typeof child.stdout, receive: (line: string) => void) => {
      let buffer = "";
      let dropping = false;
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        if (ended || this.closed) return;
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf("\n", offset);
          const end = newline < 0 ? chunk.length : newline;
          const part = chunk.slice(offset, end);
          if (!dropping) {
            if (Buffer.byteLength(buffer) + Buffer.byteLength(part) > MAX_LINE_BYTES) {
              buffer = "";
              dropping = true;
              this.o.log?.("pacer api: dropped line over 1 MiB");
            } else buffer += part;
          }
          if (newline < 0) break;
          if (!dropping) receive(buffer.replace(/\r$/, ""));
          buffer = "";
          dropping = false;
          offset = newline + 1;
        }
      });
      stream.on("end", () => {
        if (!ended && !this.closed && !dropping && buffer) receive(buffer);
        buffer = "";
      });
    };
    lines(child.stdout, (line) => this.receive(line));
    lines(child.stderr, (line) => this.o.log?.(line));
    this.resubscribe();
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch { this.o.log?.("pacer api: ignored malformed JSON line"); return; }
    if (message.jsonrpc !== "2.0") return;
    // A child that answers is healthy: later crashes restart quickly again.
    this.backoffMs = 1000;
    if (message.method === "event") {
      const event = message.params as ApiEvent | undefined;
      if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0 || typeof event.type !== "string") return;
      for (const subscription of this.subscriptions) {
        if (event.seq <= subscription.since) continue;
        subscription.since = event.seq;
        try { subscription.onEvent(event); }
        catch (e) { this.o.log?.(String(e)); }
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = message.error as { message: string; data?: { code?: ApiError["code"]; hint?: string } };
      pending.reject(new ApiError(error.data?.code ?? "internal", error.message, error.data?.hint));
    } else pending.resolve(message.result);
  }

  private request<T>(method: string, params: unknown = {}): Promise<T> {
    const child = this.child;
    if (this.closed || !child) return Promise.reject(new ApiError("internal", "pacer api exited"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (e) {
        this.pending.delete(id);
        reject(new ApiError("internal", e instanceof Error ? e.message : String(e)));
      }
    });
  }

  hello(): Promise<Hello> { return this.request("hello"); }
  snapshot(): ReturnType<ApiClient["snapshot"]> { return this.request("snapshot"); }
  call<T = unknown>(op: string, params?: unknown): Promise<T> { return this.request(op, params ?? {}); }

  private resubscribe(): void {
    if (!this.child || !this.subscriptions.size) return;
    const since = Math.min(...Array.from(this.subscriptions, (s) => s.since));
    void this.request("subscribe", { since }).catch((e) => this.o.log?.(String(e)));
  }

  subscribe(since: number, onEvent: (event: ApiEvent) => void): () => void {
    if (this.closed) return () => {};
    const subscription = { since, onEvent };
    this.subscriptions.add(subscription);
    this.resubscribe();
    return () => { this.subscriptions.delete(subscription); };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.restartTimer);
    this.subscriptions.clear();
    this.rejectPending();
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }
}
