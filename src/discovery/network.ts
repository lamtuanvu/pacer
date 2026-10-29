import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isIPv6 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { Ctx } from "../types";

/**
 * The current network: a stable hashed key, a label to show the user and the default route's interface (SEC-11 scopes the radio to it).
 * group hashes the gateway IPv4 address and the SSID. kind is how the router was identified (its IPv6 advertisement or its MAC) and gw is
 * the gateway IPv4 address, which is never stored. continues lists the keys this process saw within the last 10 minutes with the same
 * group and kind: only those may hand their entry to this key when the router identity changes (S3, NS2).
 */
export interface NetworkInfo { key: string; label: string; iface: string; group?: string; kind?: "ra" | "mac"; gw?: string; continues?: string[] }

// The front door's PATH may lack sbin, so system tools are called by absolute path.
const DARWIN = { route: "/sbin/route", arp: "/usr/sbin/arp", ipconfig: "/usr/sbin/ipconfig", networksetup: "/usr/sbin/networksetup" };
const LINUX_IP = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"];
const NMCLI = "/usr/bin/nmcli";
const IFACE = /^[A-Za-z0-9._:@-]{1,32}$/;

const MAC = /(?:[0-9a-f]{1,2}:){5}[0-9a-f]{1,2}/i;
const normMac = (m: string) => m.toLowerCase().split(":").map(x => x.padStart(2, "0")).join(":");

// SEC-5: argv only. Any failure means "not found".
async function out(ctx: Ctx, argv: string[]): Promise<string | null> {
  try { const r = await ctx.run(argv, 3000); return r.code === 0 ? r.stdout : null; } catch { return null; }
}

const linkLocal = (addr: string | undefined) => {
  const a = addr?.split("%")[0]?.toLowerCase();
  return a && isIPv6(a) && /^fe[89ab][0-9a-f]:/.test(a) ? a : undefined;
};

// The router's IPv6 link-local address from its advertisement: readable without the Local Network permission that ARP needs.
function routerAdvertisement(summary: string | null | undefined): string | undefined {
  return linkLocal(summary?.match(/^\s*RouterAdvertisement\s*:\s*from\s+([^\s,]+)/m)?.[1]);
}

// The default IPv6 router on iface. Mesh nodes and Thread border routers also advertise, so this one is preferred (S3).
function defaultRouter6(route: string | null, iface: string): string | undefined {
  const on = route?.match(/interface:\s*(\S+)/)?.[1];
  return on === undefined || on === iface ? linkLocal(route?.match(/gateway:\s*(\S+)/)?.[1]) : undefined;
}

// Whether iface is the Wi-Fi hardware port, from networksetup's "Hardware Port: Wi-Fi\nDevice: en0" blocks.
async function wifiPort(ctx: Ctx, iface: string): Promise<boolean> {
  const ports = await out(ctx, [DARWIN.networksetup, "-listallhardwareports"]);
  return !!ports?.split(/\n\s*\n/).some(b => /^Hardware Port:\s*(?:Wi-Fi|AirPort)\s*$/m.test(b) && b.match(/^Device:\s*(\S+)/m)?.[1] === iface);
}

async function darwin(ctx: Ctx) {
  const route = await out(ctx, [DARWIN.route, "-n", "get", "default"]);
  const gw = route?.match(/gateway:\s*([0-9.]+)/)?.[1];
  const iface = route?.match(/interface:\s*(\S+)/)?.[1];
  if (!gw || !iface || !IFACE.test(iface)) return null;
  const route6 = await out(ctx, [DARWIN.route, "-n", "get", "-inet6", "default"]);
  const summary = await out(ctx, [DARWIN.ipconfig, "getsummary", iface]);
  const ssid = summary?.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1]?.trim();
  const ra = defaultRouter6(route6, iface) ?? routerAdvertisement(summary);
  const mac = ra ? undefined : (await out(ctx, [DARWIN.arp, "-n", gw]))?.match(MAC)?.[0];
  if (!ra && !mac) return null;
  // A Wi-Fi network always has an SSID, so a failed or timed-out summary there is an incomplete probe (N11), as on Linux.
  const incomplete = summary === null && await wifiPort(ctx, iface);
  return { identity: ra ? `ra:${ra}` : `mac:${normMac(mac!)}`, iface, gw, ssid: ssid && ssid !== "<redacted>" ? ssid : undefined, incomplete };
}

async function linux(ctx: Ctx, exists: (path: string) => boolean) {
  const ip = LINUX_IP.find(p => exists(p));
  if (!ip) return null;
  const route = (await out(ctx, [ip, "route", "show", "default"]))?.match(/default via ([0-9.]+) dev (\S+)/);
  const [, gw, iface] = route ?? [];
  if (!gw || !iface || !IFACE.test(iface)) return null;
  const mac = (await out(ctx, [ip, "neigh", "show", gw]))?.match(/lladdr\s+(\S+)/)?.[1];
  if (!mac || !MAC.test(mac)) return null;
  // nmcli -t escapes ":" and "\\" in values with a backslash (N6).
  const ssid = (await out(ctx, [NMCLI, "-t", "-f", "active,ssid", "dev", "wifi"]))?.split("\n").find(l => l.startsWith("yes:"))?.slice(4).replace(/\\(.)/g, "$1").trim();
  // A wireless default route always has an SSID, so nmcli failing or listing none is an incomplete probe, not an SSID-less network.
  const incomplete = !ssid && exists(NMCLI) && exists(`/sys/class/net/${iface}/wireless`);
  return { identity: `mac:${normMac(mac)}`, iface, gw, ssid: ssid || undefined, incomplete };
}

type Found = { identity: string; iface: string; gw: string; ssid?: string; incomplete?: boolean };
let last: { found: Found; info: NetworkInfo } | null = null;
/** Networks this process identified recently, newest last; they decide which keys a new key continues (NS2). */
let sightings: { key: string; group?: string; kind: "ra" | "mac"; at: number }[] = [];
const CONTINUE_S = 600;
const SIGHTINGS_MAX = 16;
export function resetNetworkForTests(): void { last = null; sightings = []; }

/**
 * Null when no default route interface, router advertisement or gateway MAC is found (VPN-only, no ARP entry): the network is unknown and never advertised.
 * An incomplete probe (the SSID lookup failed on a wireless interface) returns the last network seen with the same router, interface and gateway, otherwise null.
 */
export async function currentNetwork(ctx: Ctx, deps: { platform?: NodeJS.Platform; exists?: (path: string) => boolean; now?: () => number } = {}): Promise<NetworkInfo | null> {
  const platform = deps.platform ?? process.platform;
  const found: Found | null = platform === "darwin" ? await darwin(ctx) : platform === "linux" ? await linux(ctx, deps.exists ?? existsSync) : null;
  if (!found) return null;
  if (found.incomplete) {
    const prev = last?.found;
    return prev && prev.identity === found.identity && prev.iface === found.iface && prev.gw === found.gw ? last!.info : null;
  }
  const key = createHash("sha256").update(`pacer-network/v2\0${found.identity}\0${found.ssid ?? ""}`).digest("hex").slice(0, 32);
  // Without an SSID many unrelated networks share a gateway address, so only SSID networks get a group.
  const group = found.ssid ? createHash("sha256").update(`pacer-network-group/v1\0${found.gw}\0${found.ssid}`).digest("hex").slice(0, 32) : undefined;
  const kind = found.identity.startsWith("ra:") ? "ra" as const : "mac" as const;
  const now = deps.now?.() ?? Date.now() / 1000;
  const continues = group ? [...new Set(sightings.filter(x => x.key !== key && x.group === group && x.kind === kind && x.at >= now - CONTINUE_S).map(x => x.key))] : [];
  sightings = [...sightings.filter(x => x.key !== key), { key, group, kind, at: now }].slice(-SIGHTINGS_MAX);
  const info = { key, label: found.ssid ?? `Network ${key.slice(0, 6)}`, iface: found.iface, ...(group ? { group } : {}), kind, gw: found.gw, continues };
  last = { found, info };
  return info;
}

const ipv4Bits = (a: string) => a.split(".").reduce((n, x) => ((n << 8) | Number(x)) >>> 0, 0);

/**
 * The interface's external IPv4 address and netmask whose subnet holds the gateway, otherwise its first one (N17): the radio answers and
 * listens only on that link (SEC-11). IPv4 only.
 */
export function interfaceIPv4(iface: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(), gw?: string): { addr: string; mask: string } | null {
  const v4 = interfaces[iface]?.filter(i => i.family === "IPv4" && !i.internal) ?? [];
  const onGateway = (i: NetworkInterfaceInfo) => { const m = ipv4Bits(i.netmask); return ((ipv4Bits(i.address) & m) >>> 0) === ((ipv4Bits(gw!) & m) >>> 0); };
  const found = (gw ? v4.find(onGateway) : undefined) ?? v4[0];
  return found ? { addr: found.address, mask: found.netmask } : null;
}
