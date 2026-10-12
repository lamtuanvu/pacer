import { parseEnvelope, parseSnapshot, type LinkSnapshot } from "../../../src/link/envelope";
import type { Timers } from "../plugin";
import type { Transport } from "./choose";
export interface HttpPort {
  get(url: string, token: string, timeoutMs: number): Promise<{ status: number; body: string }>;
  stream(url: string, token: string, onLine: (line: string) => void, onClose: (err?: Error) => void): () => void;
}
export function httpTransport(o: { http: HttpPort; readToken(): string | null; port: number; timers: Timers }): Transport {
  const base = `http://127.0.0.1:${o.port}`;
  async function get(): Promise<{status:number;body:string} | null> {
    let cancel = () => {};
    try {
      const token = o.readToken(); if (!token) return null;
      return await Promise.race([
        o.http.get(`${base}/link`, token, 1500),
        new Promise<null>(resolve => { cancel = o.timers.after(1500, () => resolve(null)); }),
      ]);
    } catch { return null; } finally { cancel(); }
  }
  async function snapshot(): Promise<LinkSnapshot | null> {
    const r = await get(); if (r?.status !== 200) return null;
    try { return parseSnapshot(JSON.parse(r.body)); } catch { return null; }
  }
  return {
    id: "http",
    probe: async () => (await get())?.status === 200,
    snapshot,
    watch(onEnvelope, onSnapshot) {
      let stopped = false, failures = 0;
      let stopStream = () => {}, cancelRetry = () => {};
      let refreshBusy = false;
      const reconnect = () => {
        if (stopped) return;
        const delay = [2000, 4000, 8000, 16000, 30000][Math.min(failures++, 4)];
        cancelRetry(); cancelRetry = o.timers.after(delay, connect);
      };
      const connect = () => {
        if (stopped) return;
        stopStream();
        try {
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
        void snapshot().then(s => { if (s && !stopped) onSnapshot(s); }).finally(() => { refreshBusy = false; });
      });
      connect();
      return () => { stopped = true; stopStream(); cancelRetry(); cancelPoll(); };
    },
  };
}
