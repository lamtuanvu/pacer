import type { LinkSnapshot, Envelope } from "../../../src/link/envelope";
import type { TransportChoice } from "../settings";
export type TransportId = "api" | "http" | "channel" | "bridge";
export interface Transport {
  id: TransportId;
  probe(): Promise<boolean>;
  snapshot(): Promise<LinkSnapshot | null>;
  watch(onEnvelope: (e: Envelope) => void, onSnapshot: (s: LinkSnapshot) => void, onFailure?: () => void): () => void;
}
export const TRANSPORT_ORDER: TransportId[] = ["api", "http", "channel", "bridge"];
export async function chooseTransport(ts: Transport[], forced: TransportChoice): Promise<{ transport: Transport | null; reachable: boolean }> {
  const probe = async (t: Transport) => { try { return await t.probe(); } catch { return false; } };
  if (forced !== "auto") { const transport = ts.find(t => t.id === forced) ?? null; return { transport, reachable: transport ? await probe(transport) : false }; }
  for (const id of TRANSPORT_ORDER) { const transport = ts.find(t => t.id === id); if (transport && await probe(transport)) return { transport, reachable: true }; }
  return { transport: null, reachable: false };
}
