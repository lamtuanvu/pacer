import { parseEnvelope, type Envelope } from "../../../src/link/envelope";
import type { OrcaHost } from "../orca-api";
import type { Transport } from "./choose";
export const CHANNEL_EVENT = "plugin.message";
export function channelTransport(o: { host: OrcaHost; registerEvent(name: string, h: (p: unknown) => void): void }): Transport {
  let listener: ((e: Envelope) => void) | null = null;
  o.registerEvent(CHANNEL_EVENT, p => { if (typeof p !== "object" || !p) return; const e = parseEnvelope((p as { data?: unknown }).data); if (e) listener?.(e); });
  return {
    id: "channel",
    probe: async () => { try { await o.host.call("events.subscribe", { events: [CHANNEL_EVENT] }); return true; } catch { return false; } },
    snapshot: async () => null,
    watch(onEnvelope) { listener = onEnvelope; return () => { listener = null; }; },
  };
}
