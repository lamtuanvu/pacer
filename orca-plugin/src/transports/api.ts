import type { Hello } from "../../../src/api/client-types";
import type { NotifyData } from "../../../src/notify/decide";
import type { ApiClient } from "../../../src/api/client-types";
import { parseEnvelope, type LinkSnapshot } from "../../../src/link/envelope";
import type { Timers } from "../plugin";
import type { Transport } from "./choose";

export function apiTransport(o: { connect: () => Promise<ApiClient | null>; timers: Timers; log?: (m: string) => void; notifier?: { version: string; deliver: (data: NotifyData) => Promise<unknown> } }): Transport {
  let connection: Promise<ApiClient | null> | null = null;
  let hello: Hello | null = null;
  let seq = 0;
  let watches = 0;
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
      const created = connection === null;
      const pending = client();
      try {
        const ready = await Promise.race([
          pending.then(async c => {
            if (abandoned) return false;
            if (!c) return false;
            hello = await c.hello();
            return true;
          }),
          new Promise<false>(resolve => { cancel = o.timers.after(2000, () => resolve(false)); }),
        ]);
        if (ready) return true;
      } catch (e) { o.log?.(`pacer API probe: ${String(e)}`); }
      finally { cancel(); }
      abandoned = true;
      if (created && watches === 0 && connection === pending) {
        connection = null;
        void pending.then(c => c?.close()).catch(() => {});
      }
      return false;
    },
    snapshot,
    watch(onEnvelope, onSnapshot, onFailure) {
      watches++;
      let stopped = false, busy = false, resetPending = false;
      let unsubscribe = () => {}, cancelHeartbeat = () => {};
      let clientId: string | null = null;
      const delivered = new Set<string>();
      let deliveries = Promise.resolve();
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
        const capabilities = hello ??= await c.hello();
        if (o.notifier && capabilities.ops.includes("client.register") && capabilities.events.includes("notify")) {
          const register = async () => {
            const result = await c.call<{client_id:string}>("client.register", {kind:"orca",version:o.notifier!.version,notifier:true});
            clientId = result.client_id;
          };
          await register();
          if (stopped) return;
          let renewing = false;
          cancelHeartbeat = o.timers.every(30000, () => {
            if (stopped || renewing) return;
            renewing = true;
            void c.call("client.heartbeat", {client_id:clientId}).catch(async e => {
              if (!stopped && e?.code === "invalid_input") await register();
              else o.log?.(`pacer notifier heartbeat: ${String(e)}`);
            }).catch(e => o.log?.(`pacer notifier registration: ${String(e)}`)).finally(() => { renewing = false; });
          });
        }
        if (stopped) return;
        unsubscribe = c.subscribe(seq, e => {
          if (stopped) return;
          if (e.type === "notify") {
            const data = e.data as NotifyData | null;
            if (!clientId || !data || data.client_id !== clientId || typeof data.key !== "string" || typeof data.title !== "string" || typeof data.body !== "string") return;
            deliveries = deliveries.then(async () => {
              if (stopped || delivered.has(data.key)) return;
              const result = await o.notifier!.deliver(data);
              if (result !== false) delivered.add(data.key);
            }).catch(e => o.log?.(`pacer notification: ${String(e)}`));
            return;
          }
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
      return () => { if (stopped) return; stopped = true; watches--; unsubscribe(); cancelPoll(); cancelHeartbeat(); };
    },
  };
}
