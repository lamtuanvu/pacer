import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import { writePrivateFile } from "../identity/atomic";
import { base32 } from "../identity/encoding";

/** A machine seen on the LAN. All strings are sanitized; promptedAt is set when a prompt was taken for it. */
export interface Seen { discoveryId: string; name: string; version: string; hints: string; network: string; firstSeen: number; lastSeen: number; promptedAt?: number }
/** advertise: null until the user answers the ask-once question for this network. */
export interface NetworkEntry { label: string; advertise: boolean | null; discoveryId: string; muted: boolean; askedAt?: number }
/**
 * rev moves on every write. networksRev is the revision of the user's discovery settings (the on/off switch and the network entries),
 * so radio traffic never makes a settings change stale. enabled is the machine-local on/off switch, not routing strategy.
 */
export interface DiscoveryState { rev: number; networksRev: number; enabled: boolean; networks: Record<string, NetworkEntry>; silenced: Record<string, number | "forever">; seen: Record<string, Seen>; prompts: number[] }

const LOCK = "discovery";
const path = (ctx: Ctx) => join(ctx.pacerHome, "discovery", "state.json");
const empty = (): DiscoveryState => ({ rev: 0, networksRev: 0, enabled: true, networks: {}, silenced: {}, seen: {}, prompts: [] });

export function readState(ctx: Ctx): DiscoveryState {
  if (!existsSync(path(ctx))) return empty();
  try {
    const raw = JSON.parse(readFileSync(path(ctx), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty();
    return { ...empty(), ...raw, enabled: raw.enabled !== false };
  } catch { return empty(); }
}

/** Locked read-modify-write (SEC-7). A stale expectNetworksRev is a typed conflict and writes nothing. */
export async function updateState(ctx: Ctx, fn: (s: DiscoveryState) => void, expectNetworksRev?: number): Promise<DiscoveryState> {
  if (ctx.readOnly) throw new CoreError("not_allowed", "pacer is read-only here");
  return withLock(ctx, LOCK, async () => {
    const s = readState(ctx);
    if (expectNetworksRev !== undefined && s.networksRev !== expectNetworksRev) throw new CoreError("conflict", "Discovery settings changed in another client", "Reload and try again.", { expected: expectNetworksRev, actual: s.networksRev });
    const settings = () => JSON.stringify([s.enabled, s.networks]);
    const before = settings();
    fn(s);
    s.rev += 1;
    if (settings() !== before) s.networksRev += 1;
    writePrivateFile(path(ctx), JSON.stringify(s, null, 2) + "\n");
    return s;
  });
}

/** LAN discovery (listening and advertising) is on unless the user turned it off on this machine. */
export function discoveryEnabled(ctx: Ctx): boolean { return readState(ctx).enabled; }

const newId = () => base32(randomBytes(17)).slice(0, 26);

export function ensureNetwork(s: DiscoveryState, key: string, label: string): NetworkEntry {
  return s.networks[key] ??= { label, advertise: null, discoveryId: newId(), muted: false };
}

export function resetNetworkId(entry: NetworkEntry): void { entry.discoveryId = newId(); }
