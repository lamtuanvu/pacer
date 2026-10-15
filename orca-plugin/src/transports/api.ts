import type { ApiClient } from "../../../src/api/client-types";
import { parseEnvelope, type LinkSnapshot } from "../../../src/link/envelope";
import type { Timers } from "../plugin";
import type { Transport } from "./choose";

export function apiTransport(o: { connect: () => Promise<ApiClient | null>; timers: Timers; log?: (m: string) => void }): Transport {
  let connection: Promise<ApiClient | null> | null = null;
  let seq = 0;
  const client = () => connection ??= Promise.resolve().then(o.connect);
  async function snapshot(): Promise<LinkSnapshot | null> {
    try {
      const c = await client();
      if (!c) return null;
      const result = await c.snapshot();
      seq = result.seq;
      return result.snapshot;
    } catch (e) { o.log?.(`pacer API snapshot: ${String(e)}`); return null; }
  }
  return {
    id: "api",
    async probe() {
      let cancel = () => {}, abandoned = false;
      const pending = client();
      try {
        const ready = await Promise.race([
          pending.then(async c => {
            if (abandoned) { c?.close(); return false; }
            if (!c) return false;
            await c.hello();
            return true;
          }),
          new Promise<false>(resolve => { cancel = o.timers.after(2000, () => resolve(false)); }),
        ]);
        if (ready) return true;
      } catch (e) { o.log?.(`pacer API probe: ${String(e)}`); }
      finally { cancel(); }
      abandoned = true;
      connection = null;
      void pending.then(c => c?.close()).catch(() => {});
      return false;
    },
    snapshot,
    watch(onEnvelope, onSnapshot, onFailure) {
      let stopped = false, busy = false, resetPending = false;
      let unsubscribe = () => {};
      const refresh = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
          const s = await snapshot();
          if (!stopped) { if (s) onSnapshot(s); else onFailure?.(); }
        } finally {
          busy = false;
          if (resetPending) { resetPending = false; void refresh(); }
        }
      };
      const start = async () => {
        await refresh();
        if (stopped) return;
        const c = await client();
        if (stopped || !c) return;
        unsubscribe = c.subscribe(seq, e => {
          if (stopped) return;
          if (e.type === "reset") {
            if (busy) resetPending = true; else void refresh();
            return;
          }
          if (!["budget", "task", "mode", "alert"].includes(e.type)) return;
          const envelope = parseEnvelope({ v: 1, type: e.type, data: e.data });
          if (envelope) onEnvelope(envelope);
        });
      };
      void start().catch(e => { o.log?.(`pacer API watch: ${String(e)}`); if (!stopped) onFailure?.(); });
      const cancelPoll = o.timers.every(10000, () => { void refresh(); });
      return () => { stopped = true; unsubscribe(); cancelPoll(); };
    },
  };
}
