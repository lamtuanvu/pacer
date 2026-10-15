import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Status } from "../engine/status";
import { DEFAULT_PORT } from "../serve/http";
import type { LinkSnapshot } from "../link/envelope";
import type { Ctx } from "../types";
import { eventsSince, liveSnapshot } from "./events";
import { callOp, type OpDeps } from "./ops";
import { helloBody, toApiError, type ApiErrorBody, type ApiErrorCode, type ApiEvent } from "./protocol";

export type Hello = { protocol: string; pacer: string; ops: string[]; events: string[] };

export interface ApiClient {
  kind: "inprocess" | "http";
  hello(): Promise<Hello>;
  snapshot(): Promise<{ protocol: string; seq: number; snapshot: LinkSnapshot }>;
  call<T = unknown>(op: string, params?: unknown): Promise<T>;
  subscribe(since: number, onEvent: (e: ApiEvent) => void): () => void;
  close(): void;
}

export class HttpClient implements ApiClient {
  readonly kind = "http";
  private readonly subscriptions = new Set<() => void>();

  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly o: { retryMs?: number } = {},
  ) {}

  private async request<T>(path: string, params?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method: params === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(params === undefined ? {} : { body: JSON.stringify(params) }),
    });
    if (!response.ok) {
      // 401 and other pre-routing failures have plain-text bodies.
      const text = await response.text();
      let error: ApiErrorBody["error"] | undefined;
      try { error = (JSON.parse(text) as ApiErrorBody).error; } catch { /* not a v2 error body */ }
      if (error) throw new ApiError(error.code, error.message, error.hint);
      throw new ApiError(response.status === 401 ? "not_allowed" : "internal", `pacer serve: HTTP ${response.status} ${text.trim()}`.trim());
    }
    return await response.json() as T;
  }

  hello(): Promise<Hello> { return this.request("/v2/hello"); }
  snapshot(): Promise<{ protocol: string; seq: number; snapshot: LinkSnapshot }> {
    return this.request("/v2/snapshot");
  }
  async call<T = unknown>(op: string, params?: unknown): Promise<T> {
    const body = await this.request<{ result: T }>(`/v2/ops/${encodeURIComponent(op)}`, params ?? {});
    return body.result;
  }

  subscribe(since: number, onEvent: (e: ApiEvent) => void): () => void {
    let last = since;
    let stopped = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
      this.subscriptions.delete(stop);
    };
    this.subscriptions.add(stop);
    const connect = async () => {
      controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch(`${this.base}/v2/events?since=${last}`, {
          headers: { authorization: `Bearer ${this.token}`, "Last-Event-ID": String(last) },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error("event stream unavailable");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: RegExpExecArray | null;
          while (!stopped && (boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            let id: string | undefined;
            let type: string | undefined;
            const data: string[] = [];
            for (const line of frame.split(/\r?\n/)) {
              if (line.startsWith(":")) continue;
              const colon = line.indexOf(":");
              const field = colon < 0 ? line : line.slice(0, colon);
              const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
              if (field === "id") id = value;
              if (field === "event") type = value;
              if (field === "data") data.push(value);
            }
            const seq = Number(id);
            if (id === undefined || !Number.isSafeInteger(seq) || seq < 0 || !type || !data.length) continue;
            const parsed: unknown = JSON.parse(data.join("\n"));
            last = seq;
            onEvent({ seq, at: Date.now() / 1000, type: type as ApiEvent["type"], data: parsed });
          }
        }
      } catch { /* Reconnect from the last delivered event after transport errors. */ }
      finally {
        await reader?.cancel().catch(() => {});
        if (!stopped) timer = setTimeout(() => { void connect(); }, this.o.retryMs ?? 1000);
      }
    };
    void connect();
    return stop;
  }

  close(): void { for (const stop of this.subscriptions) stop(); }
}

export async function connectClient(ctx: Ctx, o: { timeoutMs?: number; opDeps?: OpDeps } = {}): Promise<ApiClient> {
  const fallback = () => new InProcessClient(() => ctx, { opDeps: o.opDeps });
  if (ctx.env.PACER_API === "inprocess") return fallback();
  try {
    const token = readFileSync(join(ctx.pacerHome, "token"), "utf8").trim();
    if (!token) return fallback();
    const base = `http://127.0.0.1:${ctx.env.PACER_PORT ?? DEFAULT_PORT}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 300);
    try {
      const response = await fetch(`${base}/health`, { signal: controller.signal });
      await response.body?.cancel();
      if (response.status === 200 && response.headers.get("x-pacer") === "1") return new HttpClient(base, token);
    } finally { clearTimeout(timer); }
  } catch { /* A missing token or unavailable daemon uses the local core. */ }
  return fallback();
}

export class ApiError extends Error {
  constructor(public code: ApiErrorCode, message: string, public hint?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export class InProcessClient implements ApiClient {
  readonly kind = "inprocess";
  private readonly timers = new Set<ReturnType<typeof setInterval>>();

  constructor(
    private readonly getCtx: () => Ctx,
    private readonly o: { opDeps?: OpDeps; pollMs?: number; status?: (c: Ctx) => Promise<Status> } = {},
  ) {}

  async hello(): Promise<Hello> { return helloBody(); }

  snapshot(): Promise<{ protocol: string; seq: number; snapshot: LinkSnapshot }> {
    return liveSnapshot(this.getCtx(), { status: this.o.status });
  }

  async call<T = unknown>(op: string, params?: unknown): Promise<T> {
    try { return await callOp(this.getCtx(), op, params, this.o.opDeps) as T; }
    catch (e) {
      const error = toApiError(e);
      throw new ApiError(error.code, error.message, error.hint);
    }
  }

  subscribe(since: number, onEvent: (e: ApiEvent) => void): () => void {
    let last = since;
    const timer = setInterval(() => {
      const batch = eventsSince(this.getCtx(), last);
      last = batch.last;
      for (const event of batch.events) {
        if (!this.timers.has(timer)) break;
        onEvent(event);
      }
    }, this.o.pollMs ?? 1000);
    this.timers.add(timer);
    return () => { clearInterval(timer); this.timers.delete(timer); };
  }

  close(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
}
