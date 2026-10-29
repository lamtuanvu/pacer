import { z } from "zod";
import { CoreError } from "../core/errors";
import { publishConfigChange } from "../core/events";
import type { Ctx } from "../types";
import type { OpDef } from "./ops";

const op = <P extends z.ZodTypeAny>(definition: OpDef<P>) => definition as unknown as OpDef;
const discovery = () => import("../discovery");
const nowS = () => Math.floor(Date.now() / 1000);

async function list(ctx: Ctx) {
  const d = await discovery();
  const s = d.readState(ctx), net = await d.currentNetwork(ctx), now = nowS();
  const entry = net ? s.networks[net.key] : undefined;
  const { ensureIdentity } = await import("../identity/store");
  return {
    available: d.radioStatus().available,
    enabled: s.enabled,
    network: net ? { key: net.key, label: net.label, advertise: entry?.advertise ?? null, muted: entry?.muted ?? false, name: (await ensureIdentity(ctx)).name } : null,
    found: Object.values(s.seen).sort((a, b) => b.lastSeen - a.lastSeen).map(x => ({
      discoveryId: x.discoveryId, name: x.name, version: x.version, lastSeen: x.lastSeen, silenced: d.isSilenced(s, x.discoveryId, now),
    })),
    rev: s.rev,
    networksRev: s.networksRev,
  };
}

async function networks(ctx: Ctx) {
  const d = await discovery();
  const s = d.readState(ctx), net = await d.currentNetwork(ctx);
  return { rev: s.rev, networksRev: s.networksRev, current: net?.key ?? null, networks: Object.entries(s.networks).map(([key, n]) => ({ key, label: n.label, advertise: n.advertise, muted: n.muted })) };
}

/** Writes publish a `discovery` config change, so clients refetch and attention is re-derived. */
async function mutation<T>(ctx: Ctx, action: () => Promise<T>): Promise<T> {
  const result = await action();
  await publishConfigChange(ctx, "discovery");
  return result;
}

/** Client protocol v3 LAN discovery ops. Executor sessions get not_allowed for set, respond and network.set (caller policy). */
export const discoveryOps: Record<string, OpDef> = {
  "discovery.list": op({ description: "LAN discovery status on the current network and the pacer machines seen there. Names and versions are unverified. network.name is the machine name this machine advertises.",
    params: z.object({}), handler: ctx => list(ctx) }),
  "discovery.set": op({ description: "Turn LAN discovery (listening and advertising) on or off on this machine. Off closes the open prompts. It is machine-local state, not strategy, so it works before setup. expect_rev is networksRev from discovery.list or discovery.network.get.",
    params: z.object({ enabled: z.boolean(), expect_rev: z.number().int().nonnegative().safe().optional() }),
    handler: (ctx, p) => mutation(ctx, async () => {
      const s = await (await discovery()).updateState(ctx, st => { st.enabled = p.enabled; }, p.expect_rev);
      return { enabled: s.enabled, rev: s.rev, networksRev: s.networksRev };
    }) }),
  "discovery.respond": op({ description: "Answer a found-machine prompt: pair (hands over to a pairing plugin if one is installed), later (silence for 7 days), ignore (permanently) or mute-network (no more prompts on that machine's network).",
    params: z.object({ discoveryId: z.string().regex(/^[a-z2-7]{26}$/), action: z.enum(["pair", "later", "ignore", "mute-network"]) }),
    handler: async (ctx, p) => {
      const d = await discovery();
      const seen = d.readState(ctx).seen[p.discoveryId];
      if (!seen) throw new CoreError("not_found", "That machine is no longer in the list.");
      if (p.action === "pair") return { ok: true as const, pairing: await (await import("../discovery/handover")).handOver(ctx, seen) };
      return mutation(ctx, async () => {
        const now = nowS();
        await d.updateState(ctx, s => {
          if (p.action === "later") s.silenced[p.discoveryId] = now + d.SILENCE_LATER_S;
          if (p.action === "ignore") s.silenced[p.discoveryId] = "forever";
          if (p.action === "mute-network" && s.networks[seen.network]) s.networks[seen.network].muted = true;
        });
        return { ok: true as const };
      });
    } }),
  "discovery.network.get": op({ description: "Per-network advertising answers, with networksRev (the revision discovery.network.set expects) and the current network's key.", params: z.object({}), handler: ctx => networks(ctx) }),
  "discovery.network.set": op({ description: "Allow or stop advertising this machine on a network, mute its prompts, or reset its discovery id. expect_rev is networksRev from discovery.list or discovery.network.get; LAN traffic does not change it.",
    params: z.object({ network: z.string().regex(/^[0-9a-f]{32}$/), advertise: z.boolean().optional(), muted: z.boolean().optional(), resetId: z.boolean().optional(), expect_rev: z.number().int().nonnegative().safe() }),
    handler: (ctx, p) => mutation(ctx, async () => {
      const d = await discovery();
      await d.updateState(ctx, s => {
        const n = s.networks[p.network];
        if (!n) throw new CoreError("not_found", "Unknown network.");
        if (p.advertise !== undefined) { n.advertise = p.advertise; n.askedAt = nowS(); }
        if (p.muted !== undefined) n.muted = p.muted;
        if (p.resetId) d.resetNetworkId(n);
      }, p.expect_rev);
      return networks(ctx);
    }) }),
};
