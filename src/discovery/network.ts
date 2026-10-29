import { createHash } from "node:crypto";
import type { Ctx } from "../types";

/** The current network: a stable hashed key and a label to show the user. */
export interface NetworkInfo { key: string; label: string }

const MAC = /(?:[0-9a-f]{1,2}:){5}[0-9a-f]{1,2}/i;
const normMac = (m: string) => m.toLowerCase().split(":").map(x => x.padStart(2, "0")).join(":");

// SEC-5: argv only. Any failure means "not found".
async function out(ctx: Ctx, argv: string[]): Promise<string | null> {
  try { const r = await ctx.run(argv, 3000); return r.code === 0 ? r.stdout : null; } catch { return null; }
}

async function darwin(ctx: Ctx) {
  const route = await out(ctx, ["route", "-n", "get", "default"]);
  const gw = route?.match(/gateway:\s*([0-9.]+)/)?.[1];
  const iface = route?.match(/interface:\s*(\S+)/)?.[1];
  if (!gw || !iface) return null;
  const mac = (await out(ctx, ["arp", "-n", gw]))?.match(MAC)?.[0];
  if (!mac) return null;
  const ssid = (await out(ctx, ["ipconfig", "getsummary", iface]))?.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1]?.trim();
  return { mac: normMac(mac), ssid: ssid && ssid !== "<redacted>" ? ssid : undefined };
}

async function linux(ctx: Ctx) {
  const gw = (await out(ctx, ["ip", "route", "show", "default"]))?.match(/default via ([0-9.]+)/)?.[1];
  if (!gw) return null;
  const mac = (await out(ctx, ["ip", "neigh", "show", gw]))?.match(/lladdr\s+(\S+)/)?.[1];
  if (!mac || !MAC.test(mac)) return null;
  const ssid = (await out(ctx, ["nmcli", "-t", "-f", "active,ssid", "dev", "wifi"]))?.split("\n").find(l => l.startsWith("yes:"))?.slice(4).trim();
  return { mac: normMac(mac), ssid: ssid || undefined };
}

/** Null when no default gateway MAC is found (VPN-only, no ARP entry): the network is unknown and never advertised. */
export async function currentNetwork(ctx: Ctx, deps: { platform?: NodeJS.Platform } = {}): Promise<NetworkInfo | null> {
  const platform = deps.platform ?? process.platform;
  const found = platform === "darwin" ? await darwin(ctx) : platform === "linux" ? await linux(ctx) : null;
  if (!found) return null;
  const key = createHash("sha256").update(`pacer-network/v1\0${found.mac}\0${found.ssid ?? ""}`).digest("hex").slice(0, 32);
  return { key, label: found.ssid ?? `Network ${key.slice(0, 6)}` };
}
