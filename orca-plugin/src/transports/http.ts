import { parseEnvelope, parseSnapshot, type LinkSnapshot } from "../../../src/link/envelope";
import type { Timers } from "../plugin";
import type { Transport } from "./choose";
export interface HttpPort {
  post?(url: string, token: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: string; headers?: Record<string, string | string[] | undefined> }>;
  get(url: string, token: string, timeoutMs: number): Promise<{ status: number; body: string; headers?: Record<string, string | string[] | undefined> }>;
  stream(url: string, token: string, onLine: (line: string) => void, onClose: (err?: Error) => void): () => void;
}
export function httpTransport(o: { http: HttpPort; readToken(): string | null; port: number; timers: Timers }): Transport {
  const base = `http://127.0.0.1:${o.port}`;
  async function request(path: string, token: string) {
    let cancel = () => {};
    try {
      return await Promise.race([
        o.http.get(base + path, token, 1500),
        new Promise<null>(resolve => { cancel = o.timers.after(1500, () => resolve(null)); }),
      ]);
    } catch { return null; } finally { cancel(); }
  }
  async function identified(): Promise<boolean> {
    const health = await request("/health", "");
    return health?.status === 200 && health.headers?.["x-pacer"] === "1";
  }
  async function get() {
    try {
      if (!await identified()) return null;
      const token = o.readToken(); if (!token) return null;
      const response = await request("/link", token);
      return response?.headers?.["x-pacer"] === "1" ? response : null;
    } catch { return null; }
  }
  async function snapshot(): Promise<LinkSnapshot | null> {
    const r = await get(); if (r?.status !== 200) return null;
    try { return parseSnapshot(JSON.parse(r.body)); } catch { return null; }
  }
  return {
    id: "http",
    probe: async () => (await get())?.status === 200,
    snapshot,
    watch(onEnvelope, onSnapshot, onFailure) {
      let stopped = false, failures = 0;
      let stopStream = () => {}, cancelRetry = () => {};
      let refreshBusy = false;
      const reconnect = () => {
        if (stopped) return;
        const delay = [2000, 4000, 8000, 16000, 30000][Math.min(failures++, 4)];
        cancelRetry(); cancelRetry = o.timers.after(delay, () => { void connect(); });
      };
      const connect = async () => {
        if (stopped) return;
        stopStream();
        try {
          if (!await identified()) { reconnect(); return; }
          if (stopped) return;
          const token = o.readToken(); if (!token) { reconnect(); return; }
          stopStream = o.http.stream(`${base}/events`, token, chunk => {
            for (const line of chunk.split(/\r?\n/)) {
              if (!line.startsWith("data: ")) continue;
              try { const e = parseEnvelope(JSON.parse(line.slice(6))); if (e) { failures = 0; onEnvelope(e); } } catch { /* malformed or unrelated SSE data */ }
            }
          }, reconnect);
        } catch { reconnect(); }
      };
      const cancelPoll = o.timers.every(10000, () => {
        if (refreshBusy) return;
        refreshBusy = true;
        void snapshot().then(s => { if (!stopped) { if (s) onSnapshot(s); else onFailure?.(); } }).finally(() => { refreshBusy = false; });
      });
      void connect();
      return () => { stopped = true; stopStream(); cancelRetry(); cancelPoll(); };
    },
  };
}
