import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as config from "../src/core/config";
import { deriveItems, type RuleInput } from "../src/attention/rules";
import { toNotify } from "../src/notify/decide";
import { fakeCtx } from "./helpers";
import { discoveryRuleInput } from "../src/discovery/prompts";
import { buildRadioConfig, recordObservations, resetRadioForTests } from "../src/discovery/radio";
import { readState, updateState } from "../src/discovery/state";
import { clearIdentityCache, ensureIdentity, setIdentityPlatformForTests } from "../src/identity/store";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); resetRadioForTests(); });
const peer = "a".repeat(26);
const K1 = "0123456789abcdef0123456789abcdef";
const base = (discovery: RuleInput["discovery"]): RuleInput => ({ now: 1000, tasks: [], executors: [], accounts: [], planner: null, setup: { items: [] } as any, update: null, retryTarget: () => null, discovery });

test("a found machine raises Pair and Later; an unanswered network raises the advertise question", () => {
  const items = deriveItems(base({
    networksRev: 7,
    prompted: [{ discoveryId: peer, name: "studio-mac", at: 900 }],
    network: { key: K1, label: "home-wifi", advertise: null, name: "pacer-k3x9" },
  }));
  const found = items.find(i => i.id === `discovery:${peer}`)!;
  expect(found.kind).toBe("discovery");
  expect(found.actions.map(a => a.label)).toEqual(["Pair", "Later"]);
  expect(found.actions[0]).toMatchObject({ op: "discovery.respond", params: { discoveryId: peer, action: "pair" }, style: "primary" });
  expect(found.actions[1]).toMatchObject({ op: "discovery.respond", params: { discoveryId: peer, action: "later" } });
  expect(found.title).toContain("studio-mac");
  expect(found.detail).toContain("Unverified");
  expect(found.notify).toBe("important");
  expect(found.since).toBe(900);
  const net = items.find(i => i.id === "discovery-network:" + K1)!;
  expect(net.title).toBe("Let your other machines find this one on home-wifi?");
  expect(net.detail).toContain("pacer-k3x9");
  expect(net.actions).toEqual([
    { label: "Allow", op: "discovery.network.set", params: { network: K1, advertise: true, expect_rev: 7 }, style: "primary" },
    { label: "Not on this network", op: "discovery.network.set", params: { network: K1, advertise: false, expect_rev: 7 } },
  ]);
});

test("an answered network raises no question and no discovery input raises nothing", () => {
  expect(deriveItems(base({ networksRev: 1, prompted: [], network: { key: K1, label: "x", advertise: true, name: "n" } }))).toEqual([]);
  expect(deriveItems(base(undefined))).toEqual([]);
});

test("desktop notifications carry only Pair and Later", () => {
  const items = deriveItems(base({ networksRev: 1, prompted: [{ discoveryId: peer, name: "studio", at: 900 }], network: null }));
  const [n] = toNotify(items, "important", {});
  expect(n.data.actions.map(a => a.label)).toEqual(["Pair", "Later"]);
});

test("the rule input lists prompted, unsilenced machines and the radio's unanswered network", async () => {
  const ctx = fakeCtx();
  const name = (await ensureIdentity(ctx)).name;
  await buildRadioConfig(ctx, { network: { key: K1, label: "home-wifi", iface: "en0" } });
  const now = Math.floor(Date.now() / 1000);
  await recordObservations(ctx, [{ id: peer, name: "studio", v: "1", h: "" }, { id: "b".repeat(26), name: "other", v: "1", h: "" }], { now, network: { key: K1, label: "home-wifi", iface: "en0" } });
  await updateState(ctx, s => { s.silenced["b".repeat(26)] = "forever"; });
  const input = discoveryRuleInput(ctx, now)!;
  expect(input.networksRev).toBe(readState(ctx).networksRev);
  expect(input.networksRev).not.toBe(readState(ctx).rev);
  expect(input.prompted).toEqual([{ discoveryId: peer, name: "studio", at: now }]);
  expect(input.network).toEqual({ key: K1, label: "home-wifi", advertise: null, name });
  // Old prompts and muted networks raise nothing.
  expect(discoveryRuleInput(ctx, now + 8 * 86400)!.prompted).toEqual([]);
  await updateState(ctx, s => { s.networks[K1].muted = true; });
  expect(discoveryRuleInput(ctx, now)!.prompted).toEqual([]);
});

test("the rule input is undefined when discovery is off", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\npacing: {policy: priority}\nrouting: [{default: [codex]}]\n");
  await ensureIdentity(ctx);
  await buildRadioConfig(ctx, { network: { key: K1, label: "home-wifi", iface: "en0" } });
  expect(discoveryRuleInput(ctx, 1000)?.network).toMatchObject({ key: K1 });
  await config.set(ctx, "discovery", "off");
  expect(discoveryRuleInput(ctx, 1000)).toBeUndefined();
});
