import { dashboardClient } from "../dashboard/client";
import type { ApiClient } from "../api/client-types";
import type { Ctx } from "../types";
import type { Command, Result } from "./types";

type Found = { discoveryId: string; name: string; version: string; lastSeen: number; silenced: boolean };
type Listing = { available: boolean; enabled: boolean; network: { key: string; label: string; advertise: boolean | null; muted: boolean; name: string } | null; found: Found[]; rev: number; networksRev: number };
type Networks = { rev: number; networksRev: number; current: string | null; networks: { key: string; label: string; advertise: boolean | null; muted: boolean }[] };
type Respond = { ok: true; pairing?: { handedOver: boolean; plugin?: string } };

const usage = "usage: pacer discovery ls [--json] | pair|later|ignore <id-prefix> | mute-network | network [--advertise on|off] [--json]";
const fail = (message: string): Result => ({ code: 2, out: "", err: `pacer: ${message}` });
const answer = (advertise: boolean | null) => advertise === null ? "not answered" : advertise ? "advertising" : "not advertising";

/** A network with no SSID is already labelled "Network <id>". */
const networkName = (label: string) => label.startsWith("Network ") ? label : `Network ${label}`;

function formatList(l: Listing): string {
  const head = !l.enabled ? "Discovery is off." : !l.available ? "Discovery is unavailable: the pacer service is not running its LAN radio."
    : l.network ? `${networkName(l.network.label)}: ${answer(l.network.advertise)} as ${l.network.name}${l.network.muted ? ", prompts muted" : ""}.` : "Network unknown: this machine is not advertised.";
  const rows = l.found.map(f => `${f.discoveryId.slice(0, 8)}  ${f.name}  ${f.version || "-"}${f.silenced ? "  silenced" : ""}`);
  return [head, ...(rows.length ? ["Found (names are unverified):", ...rows] : ["No pacer machines found."])].join("\n");
}
function formatNetworks(n: Networks): string {
  if (!n.networks.length) return "No networks recorded.";
  return n.networks.map(x => `${x.key === n.current ? "*" : " "} ${x.label}  ${answer(x.advertise)}${x.muted ? "  prompts muted" : ""}`).join("\n");
}

export async function discoveryCmd(args: string[], ctx: Ctx, connect: (ctx: Ctx) => Promise<ApiClient> = dashboardClient): Promise<Result> {
  let client: ApiClient | undefined;
  try {
    const json = args.includes("--json");
    const rest = args.filter(a => a !== "--json");
    const [verb = "ls", ...more] = rest;
    let advertise: boolean | undefined;
    if (verb === "network" && more.length) {
      if (more.length !== 2 || more[0] !== "--advertise" || !["on", "off"].includes(more[1])) return fail(usage);
      advertise = more[1] === "on";
    } else if (["pair", "later", "ignore"].includes(verb) ? more.length !== 1 : !["ls", "mute-network", "network"].includes(verb) || more.length) return fail(usage);
    client = await connect(ctx);
    const c = client;
    const print = (value: unknown, text: string): Result => ({ code: 0, out: json ? JSON.stringify(value, null, 2) : text, err: "" });
    if (verb === "ls") { const l = await c.call<Listing>("discovery.list", {}); return print(l, formatList(l)); }
    if (verb === "network" || verb === "mute-network") {
      const n = await c.call<Networks>("discovery.network.get", {});
      if (verb === "network" && advertise === undefined) return print(n, formatNetworks(n));
      if (!n.current || !n.networks.some(x => x.key === n.current)) return fail("this machine's current network is unknown, so there is nothing to change.");
      const changed = await c.call<Networks>("discovery.network.set", { network: n.current, ...(verb === "mute-network" ? { muted: true } : { advertise }), expect_rev: n.networksRev });
      return print(changed, formatNetworks(changed));
    }
    const prefix = more[0].toLowerCase();
    const matches = (await c.call<Listing>("discovery.list", {})).found.filter(f => f.discoveryId.startsWith(prefix));
    if (matches.length > 1) return fail(`${prefix} is ambiguous; it matches ${matches.length} machines.`);
    if (!matches.length) return fail(`no found machine matches ${prefix}; it was not found.`);
    const [m] = matches;
    const r = await c.call<Respond>("discovery.respond", { discoveryId: m.discoveryId, action: verb });
    const text = verb === "pair"
      ? r.pairing?.handedOver ? `Pairing with ${m.name} continues in ${r.pairing.plugin ?? "a plugin"}.` : "No plugin that provides pairing is installed."
      : verb === "later" ? `No more prompts for ${m.name} for 7 days.` : `${m.name} will not be offered again.`;
    return print(r, text);
  } catch (error) {
    const hint = error && typeof error === "object" && "hint" in error ? error.hint : undefined;
    return { code: 2, out: "", err: `pacer: ${error instanceof Error ? error.message : String(error)}${hint ? `\n${hint}` : ""}` };
  } finally { client?.close(); }
}

export const discoveryCommand: Command = { name: "discovery", usage: `${"discovery ls|pair|later|ignore|network".padEnd(47)}pacer machines on this LAN and whether this one is advertised`, run: discoveryCmd };
export const COMMANDS: Command[] = [discoveryCommand];
