import type { Ctx } from "../types";
import { publish } from "../link/publish";
import { discoveryEnabled } from "../core/config";
import { ensureIdentity } from "../identity/store";
import { currentVersion } from "../update/version";
import { currentNetwork, type NetworkInfo } from "./network";
import { DISCOVERY_ID, isSilenced, takePrompt } from "./policy";
import { sanitizeText } from "./sanitize";
import { ensureNetwork, readState, updateState } from "./state";

/**
 * What the front door's radio should do. advertise is null unless the user approved the current network.
 * iface is the default route's interface, the only one the radio may use (SEC-11); null means neither listen nor advertise.
 */
export interface RadioConfig { rev: number; enabled: boolean; listen: boolean; iface: string | null; advertise: null | { instance: string; port: number; txt: Record<string, string> } }
/** One raw TXT record set from the radio. Every field is untrusted (SEC-16). */
export interface Observation { id: unknown; name: unknown; v: unknown; h: unknown; iface?: unknown }
export interface PairingHints { port?: number; h?: string }

const MAX_BATCH = 64;
const DISCARD_PORT = 9;

let lastContact: number | null = null;
let lastNetwork: NetworkInfo | null = null;
export function resetRadioForTests(): void { lastContact = null; lastNetwork = null; }
/** The network the radio last pulled its config on. */
export function radioNetwork(): NetworkInfo | null { return lastNetwork; }
/** The radio counts as available when it pulled its config within the last 30 s. */
export function radioStatus(): { available: boolean; lastContact: number | null } {
  return { available: lastContact !== null && Date.now() / 1000 - lastContact < 30, lastContact };
}

export async function buildRadioConfig(ctx: Ctx, deps: { network?: NetworkInfo | null; hintsFor?: () => PairingHints | null } = {}): Promise<RadioConfig> {
  lastContact = Date.now() / 1000;
  if (!discoveryEnabled(ctx)) { lastNetwork = null; return { rev: readState(ctx).rev, enabled: false, listen: false, iface: null, advertise: null }; }
  const network = deps.network !== undefined ? deps.network : await currentNetwork(ctx);
  lastNetwork = network;
  if (!network) return { rev: readState(ctx).rev, enabled: true, listen: false, iface: null, advertise: null };
  const iface = network.iface;
  let s = readState(ctx);
  if (!s.networks[network.key] && !ctx.readOnly) s = await updateState(ctx, st => { ensureNetwork(st, network.key, network.label); });
  const entry = s.networks[network.key];
  if (entry?.advertise !== true) return { rev: s.rev, enabled: true, listen: true, iface, advertise: null };
  // SEC-11: only the per-network id, the machine name and the version; never the machine id or the OS user name.
  const identity = await ensureIdentity(ctx);
  const hints = deps.hintsFor?.() ?? null;
  const txt: Record<string, string> = { id: entry.discoveryId, name: sanitizeText(identity.name, 64) ?? "pacer", v: sanitizeText(currentVersion(), 32) ?? "" };
  const h = sanitizeText(hints?.h, 200);
  if (h) txt.h = h;
  const port = Number.isInteger(hints?.port) && hints!.port! > 0 && hints!.port! < 65536 ? hints!.port! : DISCARD_PORT;
  return { rev: s.rev, enabled: true, listen: true, iface, advertise: { instance: entry.discoveryId, port, txt } };
}

/** Records sanitized observations; returns the discovery ids that may be prompted for now. */
export async function recordObservations(ctx: Ctx, batch: Observation[], deps: { now?: number; network?: NetworkInfo | null } = {}): Promise<{ accepted: number; prompted: string[] }> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const network = deps.network ?? null;
  const prompted: string[] = [];
  let accepted = 0;
  const s = await updateState(ctx, s => {
    const own = new Set(Object.values(s.networks).map(n => n.discoveryId));
    const muted = network ? s.networks[network.key]?.muted === true : false;
    for (const o of batch.slice(0, MAX_BATCH)) {
      const id = o && typeof o.id === "string" && DISCOVERY_ID.test(o.id) ? o.id : null;
      if (!id || own.has(id)) continue;
      const prev = s.seen[id];
      const seen = s.seen[id] = {
        ...prev,
        discoveryId: id, name: sanitizeText(o.name, 64) ?? "Unnamed pacer", version: sanitizeText(o.v, 32) ?? "", hints: sanitizeText(o.h, 200) ?? "",
        network: network?.key ?? "", firstSeen: prev?.firstSeen ?? now, lastSeen: now,
      };
      accepted++;
      if (!prev && !muted && !isSilenced(s, id, now) && takePrompt(s, now)) { seen.promptedAt = now; prompted.push(id); }
    }
  });
  if (prompted.length) await publish(ctx, prompted.map(id => ({ type: "discovery.found" as const, data: { discoveryId: id, name: s.seen[id].name, version: s.seen[id].version } })));
  return { accepted, prompted };
}
