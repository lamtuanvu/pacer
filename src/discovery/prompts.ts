import type { Action } from "../attention/types";
import { discoveryEnabled } from "../core/config";
import { cachedIdentity, readMeta } from "../identity/store";
import type { Ctx } from "../types";
import { isSilenced, SILENCE_LATER_S } from "./policy";
import { radioNetwork, radioStatus } from "./radio";
import { readState } from "./state";

/** What the attention rules need: machines a prompt was taken for, and the current network if its question is open. */
export interface DiscoveryRuleInput {
  /** The network-answer revision the Allow / Not on this network actions expect. */
  networksRev: number;
  prompted: { discoveryId: string; name: string; at: number }[];
  network: { key: string; label: string; advertise: boolean | null; name: string } | null;
}
export interface DiscoveryPrompt { kind: "discovery" | "discovery-network"; key: string; title: string; detail: string; actions: Action[]; since?: number }

function machineName(ctx: Ctx): string | null {
  try { return cachedIdentity(ctx)?.name ?? readMeta(ctx)?.name ?? null; } catch { return null; }
}

/** Undefined when discovery is off. Prompts last as long as a Later would (7 days) and end when silenced or muted. */
export function discoveryRuleInput(ctx: Ctx, now: number): DiscoveryRuleInput | undefined {
  if (!discoveryEnabled(ctx)) return undefined;
  const s = readState(ctx);
  const prompted = Object.values(s.seen)
    .filter(x => x.promptedAt !== undefined && x.promptedAt > now - SILENCE_LATER_S && !isSilenced(s, x.discoveryId, now) && s.networks[x.network]?.muted !== true)
    .sort((a, b) => a.promptedAt! - b.promptedAt!)
    .map(x => ({ discoveryId: x.discoveryId, name: x.name, at: x.promptedAt! }));
  const net = radioStatus().available ? radioNetwork() : null;
  const entry = net ? s.networks[net.key] : undefined;
  const name = machineName(ctx);
  return { networksRev: s.networksRev, prompted, network: net && entry && name ? { key: net.key, label: entry.label, advertise: entry.advertise, name } : null };
}

/** Discovered names are untrusted (SEC-16): shown as unverified, never used in an op other than by discovery id. */
export function discoveryPrompts(input: DiscoveryRuleInput): DiscoveryPrompt[] {
  const out: DiscoveryPrompt[] = input.prompted.map(p => ({
    kind: "discovery", key: p.discoveryId, since: p.at,
    title: `Found pacer on ${p.name}`,
    detail: "Unverified name. Pair only if this is your machine.",
    actions: [
      { label: "Pair", op: "discovery.respond", params: { discoveryId: p.discoveryId, action: "pair" }, style: "primary" },
      { label: "Later", op: "discovery.respond", params: { discoveryId: p.discoveryId, action: "later" } },
    ],
  }));
  const n = input.network;
  if (n && n.advertise === null) out.push({
    kind: "discovery-network", key: n.key,
    title: `Let your other machines find this one on ${n.label}?`,
    detail: `It will appear as ${n.name}.`,
    actions: [
      { label: "Allow", op: "discovery.network.set", params: { network: n.key, advertise: true, expect_rev: input.networksRev }, style: "primary" },
      { label: "Not on this network", op: "discovery.network.set", params: { network: n.key, advertise: false, expect_rev: input.networksRev } },
    ],
  });
  return out;
}
