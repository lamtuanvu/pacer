import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isIPv6 } from "node:net";
import type { Ctx } from "../types";

/** The current network: a stable hashed key, a label to show the user and the default route's interface (SEC-11 scopes the radio to it). */
export interface NetworkInfo { key: string; label: string; iface: string }

// The front door's PATH may lack sbin, so system tools are called by absolute path.
const DARWIN = { route: "/sbin/route", arp: "/usr/sbin/arp", ipconfig: "/usr/sbin/ipconfig" };
const LINUX_IP = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"];
const NMCLI = "/usr/bin/nmcli";
const IFACE = /^[A-Za-z0-9._:@-]{1,32}$/;

const MAC = /(?:[0-9a-f]{1,2}:){5}[0-9a-f]{1,2}/i;
const normMac = (m: string) => m.toLowerCase().split(":").map(x => x.padStart(2, "0")).join(":");

// SEC-5: argv only. Any failure means "not found".
async function out(ctx: Ctx, argv: string[]): Promise<string | null> {
  try { const r = await ctx.run(argv, 3000); return r.code === 0 ? r.stdout : null; } catch { return null; }
}

// The router's IPv6 link-local address from its advertisement: readable without the Local Network permission that ARP needs.
function routerAdvertisement(summary: string | null | undefined): string | undefined {
  const src = summary?.match(/^\s*RouterAdvertisement\s*:\s*from\s+([^\s,]+)/m)?.[1]?.split("%")[0]?.toLowerCase();
  return src && isIPv6(src) && /^fe[89ab][0-9a-f]:/.test(src) ? src : undefined;
}

async function darwin(ctx: Ctx) {
  const route = await out(ctx, [DARWIN.route, "-n", "get", "default"]);
  const gw = route?.match(/gateway:\s*([0-9.]+)/)?.[1];
  const iface = route?.match(/interface:\s*(\S+)/)?.[1];
  if (!gw || !iface || !IFACE.test(iface)) return null;
  const summary = await out(ctx, [DARWIN.ipconfig, "getsummary", iface]);
  const ssid = summary?.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1]?.trim();
  const ra = routerAdvertisement(summary);
  const mac = ra ? undefined : (await out(ctx, [DARWIN.arp, "-n", gw]))?.match(MAC)?.[0];
  if (!ra && !mac) return null;
  return { identity: ra ? `ra:${ra}` : `mac:${normMac(mac!)}`, iface, ssid: ssid && ssid !== "<redacted>" ? ssid : undefined };
}

async function linux(ctx: Ctx, exists: (path: string) => boolean) {
  const ip = LINUX_IP.find(p => exists(p));
  if (!ip) return null;
  const route = (await out(ctx, [ip, "route", "show", "default"]))?.match(/default via ([0-9.]+) dev (\S+)/);
  const [, gw, iface] = route ?? [];
  if (!gw || !iface || !IFACE.test(iface)) return null;
  const mac = (await out(ctx, [ip, "neigh", "show", gw]))?.match(/lladdr\s+(\S+)/)?.[1];
  if (!mac || !MAC.test(mac)) return null;
  const ssid = (await out(ctx, [NMCLI, "-t", "-f", "active,ssid", "dev", "wifi"]))?.split("\n").find(l => l.startsWith("yes:"))?.slice(4).trim();
  return { identity: `mac:${normMac(mac)}`, iface, ssid: ssid || undefined };
}

/** Null when no default route interface, router advertisement or gateway MAC is found (VPN-only, no ARP entry): the network is unknown and never advertised. */
export async function currentNetwork(ctx: Ctx, deps: { platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {}): Promise<NetworkInfo | null> {
  const platform = deps.platform ?? process.platform;
  const found = platform === "darwin" ? await darwin(ctx) : platform === "linux" ? await linux(ctx, deps.exists ?? existsSync) : null;
  if (!found) return null;
  const key = createHash("sha256").update(`pacer-network/v2\0${found.identity}\0${found.ssid ?? ""}`).digest("hex").slice(0, 32);
  return { key, label: found.ssid ?? `Network ${key.slice(0, 6)}`, iface: found.iface };
}
