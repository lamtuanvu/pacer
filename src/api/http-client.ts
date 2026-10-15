import type { LinkSnapshot } from "../link/envelope";
import { ApiError, type ApiClient, type Hello } from "./client-types";
import type { ApiErrorBody, ApiEvent } from "./protocol";

export class HttpClient implements ApiClient {
  readonly kind = "http";
  private readonly subscriptions = new Set<() => void>();

  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly o: { retryMs?: number } = {},
  ) {
    const url = new URL(base);
    if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(base) ||
        url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("pacer API base must be http://127.0.0.1:<port> without credentials");
    }
  }

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

