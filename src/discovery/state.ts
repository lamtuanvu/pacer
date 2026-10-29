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
export interface DiscoveryState { rev: number; networks: Record<string, NetworkEntry>; silenced: Record<string, number | "forever">; seen: Record<string, Seen>; prompts: number[] }

const LOCK = "discovery";
const path = (ctx: Ctx) => join(ctx.pacerHome, "discovery", "state.json");
const empty = (): DiscoveryState => ({ rev: 0, networks: {}, silenced: {}, seen: {}, prompts: [] });

export function readState(ctx: Ctx): DiscoveryState {
  if (!existsSync(path(ctx))) return empty();
  try {
    const raw = JSON.parse(readFileSync(path(ctx), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...empty(), ...raw } : empty();
  } catch { return empty(); }
}

/** Locked read-modify-write (SEC-7). A stale expectRev is a typed conflict and writes nothing. */
export async function updateState(ctx: Ctx, fn: (s: DiscoveryState) => void, expectRev?: number): Promise<DiscoveryState> {
  if (ctx.readOnly) throw new CoreError("not_allowed", "pacer is read-only here");
  return withLock(ctx, LOCK, async () => {
    const s = readState(ctx);
    if (expectRev !== undefined && s.rev !== expectRev) throw new CoreError("conflict", "Discovery settings changed in another client", "Reload and try again.", { expected: expectRev, actual: s.rev });
    fn(s);
    s.rev += 1;
    writePrivateFile(path(ctx), JSON.stringify(s, null, 2) + "\n");
    return s;
  });
}

const newId = () => base32(randomBytes(17)).slice(0, 26);

export function ensureNetwork(s: DiscoveryState, key: string, label: string): NetworkEntry {
  return s.networks[key] ??= { label, advertise: null, discoveryId: newId(), muted: false };
}

export function resetNetworkId(entry: NetworkEntry): void { entry.discoveryId = newId(); }
