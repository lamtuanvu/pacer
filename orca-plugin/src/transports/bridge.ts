import { contentKey, parseSnapshot } from "../../../src/link/envelope";
import type { OrcaHost } from "../orca-api";
import type { Timers } from "../plugin";
import type { Transport } from "./choose";
export function bridgeTransport(o: { host: OrcaHost; pollMs: number; timers: Timers }): Transport {
  async function snapshot() { try { return parseSnapshot((await o.host.call("storage.get", { key: "link" })).value); } catch { return null; } }
  return {
    id: "bridge", snapshot, probe: async () => (await snapshot()) !== null,
    watch(_onEnvelope, onSnapshot) {
      let key: string | null = null, stopped = false, busy = false;
      const cancel = o.timers.every(Math.min(o.pollMs,1000), () => {
        if (busy) return; busy = true;
        void snapshot().then(s => { if (s && !stopped) { const next = contentKey(s); if (next !== key) { key = next; onSnapshot(s); } } }).finally(() => { busy = false; });
      });
      return () => { stopped = true; cancel(); };
    },
  };
}
