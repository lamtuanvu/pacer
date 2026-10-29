import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import { writePrivateFile } from "../identity/atomic";
import { base32 } from "../identity/encoding";

/** A machine seen on the LAN. All strings are sanitized; promptedAt is set when a prompt was taken for it. */
export interface Seen { discoveryId: string; name: string; version: string; hints: string; network: string; firstSeen: number; lastSeen: number; promptedAt?: number; handedOverAt?: number }
/** advertise: null until the user answers the ask-once question for this network. */
/** aliases are other keys the same network was identified by; group hashes its gateway IPv4 and SSID (see NetworkInfo). */
export interface NetworkEntry { label: string; advertise: boolean | null; discoveryId: string; muted: boolean; askedAt?: number; aliases?: string[]; group?: string }
/**
 * rev moves on every write. networksRev is the revision of the user's discovery settings (the on/off switch and the network entries),
 * so radio traffic never makes a settings change stale. enabled is the machine-local on/off switch, not routing strategy.
 */
export interface DiscoveryState { rev: number; networksRev: number; enabled: boolean; networks: Record<string, NetworkEntry>; silenced: Record<string, number | "forever">; seen: Record<string, Seen>; prompts: number[]; corrupt?: true }

/** SEC-16: untrusted senders control what is seen, so the list is bounded and old entries expire. */
export const SEEN_MAX = 256;
export const SEEN_EXPIRE_S = 30 * 24 * 3600;
const PROMPT_KEEP_S = 7 * 24 * 3600;

const LOCK = "discovery";
const path = (ctx: Ctx) => join(ctx.pacerHome, "discovery", "state.json");
const empty = (): DiscoveryState => ({ rev: 0, networksRev: 0, enabled: true, networks: {}, silenced: {}, seen: {}, prompts: [] });

/** A file that exists but does not parse fails closed: discovery is off and corrupt is set until discovery.set replaces it. */
export function readState(ctx: Ctx): DiscoveryState {
  if (!existsSync(path(ctx))) return empty();
  const corrupt = (): DiscoveryState => ({ ...empty(), enabled: false, corrupt: true });
  try {
    const raw = JSON.parse(readFileSync(path(ctx), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return corrupt();
    const { corrupt: _, ...rest } = raw;
    return { ...empty(), ...rest, enabled: raw.enabled !== false };
  } catch { return corrupt(); }
}

/**
 * Locked read-modify-write (SEC-7). A stale expectNetworksRev is a typed conflict and writes nothing. While the file is corrupt only
 * a recover write (the on/off switch) may replace it; any other write is a conflict, so the warning stays until the user acts (N12).
 */
export async function updateState(ctx: Ctx, fn: (s: DiscoveryState) => void, expectNetworksRev?: number, opts: { recover?: boolean } = {}): Promise<DiscoveryState> {
  if (ctx.readOnly) throw new CoreError("not_allowed", "pacer is read-only here");
  return withLock(ctx, LOCK, async () => {
    const s = readState(ctx);
    if (s.corrupt && !opts.recover) throw new CoreError("conflict", "The discovery state file could not be read", "Turn discovery on again to start over.");
    if (expectNetworksRev !== undefined && s.networksRev !== expectNetworksRev) throw new CoreError("conflict", "Discovery settings changed in another client", "Reload and try again.", { expected: expectNetworksRev, actual: s.networksRev });
    const settings = () => JSON.stringify([s.enabled, s.networks]);
    const before = settings();
    fn(s);
    delete s.corrupt;
    s.rev += 1;
    if (settings() !== before) s.networksRev += 1;
    writePrivateFile(path(ctx), JSON.stringify(s, null, 2) + "\n");
    return s;
  });
}

/** LAN discovery (listening and advertising) is on unless the user turned it off on this machine. */
export function discoveryEnabled(ctx: Ctx): boolean { return readState(ctx).enabled; }

/**
 * Drops machines not seen for 30 days, then evicts the least recently seen beyond SEEN_MAX. Machines prompted
 * within the last 7 days (their prompt is still open) and silenced machines are kept while they are recent.
 */
export function pruneSeen(s: DiscoveryState, now: number): void {
  for (const [id, x] of Object.entries(s.seen)) if (!(x.lastSeen > now - SEEN_EXPIRE_S)) delete s.seen[id];
  const ids = Object.keys(s.seen);
  if (ids.length <= SEEN_MAX) return;
  const kept = (x: Seen) => (x.promptedAt !== undefined && x.promptedAt > now - PROMPT_KEEP_S) || s.silenced[x.discoveryId] !== undefined;
  const evictable = Object.values(s.seen).filter(x => !kept(x)).sort((a, b) => a.lastSeen - b.lastSeen);
  for (let n = ids.length; n > SEEN_MAX && evictable.length; n--) delete s.seen[evictable.shift()!.discoveryId];
}

const newId = () => base32(randomBytes(17)).slice(0, 26);

export function ensureNetwork(s: DiscoveryState, key: string, label: string, group?: string): NetworkEntry {
  return s.networks[key] ??= { label, advertise: null, discoveryId: newId(), muted: false, ...(group ? { group } : {}) };
}

type NetworkRef = { key: string; label: string; group?: string; continues?: string[] };

/**
 * The entry key for a network: its own key, an entry that lists it as an alias, or an entry with the same group (same gateway IPv4
 * and SSID) whose key or alias this process saw within the last 10 minutes with the same kind of router identity (net.continues).
 * A same-group entry not seen that recently is a different network that only shares an SSID and gateway, so it is not adopted
 * (NS2). adopt is true when the entry should record the key (S3).
 */
export function findNetwork(s: DiscoveryState, net: NetworkRef): { key: string; adopt: boolean } | null {
  const own = s.networks[net.key];
  if (own) return { key: net.key, adopt: !!net.group && own.group !== net.group };
  const alias = Object.entries(s.networks).find(([, n]) => n.aliases?.includes(net.key));
  if (alias) return { key: alias[0], adopt: false };
  const recent = new Set(net.continues ?? []);
  const same = net.group ? Object.entries(s.networks).find(([key, n]) => n.group === net.group && [key, ...n.aliases ?? []].some(k => recent.has(k))) : undefined;
  return same ? { key: same[0], adopt: true } : null;
}

/** The entry key a network is stored under, without writing; its own key when it is not known yet. */
export function networkKey(s: DiscoveryState, net: NetworkRef): string { return findNetwork(s, net)?.key ?? net.key; }

/** Records a network under its entry: learns the group, adds the key as an alias, or creates a new entry. Returns the entry key. */
export function adoptNetwork(s: DiscoveryState, net: NetworkRef): string {
  const found = findNetwork(s, net);
  if (!found) { ensureNetwork(s, net.key, net.label, net.group); return net.key; }
  const entry = s.networks[found.key];
  if (found.adopt && found.key === net.key) entry.group = net.group;
  else if (found.adopt) entry.aliases = [...(entry.aliases ?? []), net.key].slice(-8);
  return found.key;
}

export function resetNetworkId(entry: NetworkEntry): void { entry.discoveryId = newId(); }
