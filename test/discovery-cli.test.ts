import { beforeEach, expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { discoveryCommand } from "../src/commands/discovery";
import { findCommand } from "../src/commands";
import { recordObservations, resetRadioForTests } from "../src/discovery/radio";
import { readState } from "../src/discovery/state";
import { clearIdentityCache, setIdentityPlatformForTests } from "../src/identity/store";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); resetRadioForTests(); });
function setup() { const ctx = fakeCtx(); ctx.env.PACER_API = "inprocess"; return ctx; }
const home = { key: "0123456789abcdef0123456789abcdef", label: "home", iface: "en0" };

test("ls lists found machines; ignore accepts an unambiguous id prefix", async () => {
  const ctx = setup();
  const id = "abcd" + "a".repeat(22);
  await recordObservations(ctx, [{ id, name: "studio", v: "1", h: "" }], { now: 1, network: home });
  const ls = await discoveryCommand.run(["ls", "--json"], ctx);
  expect(JSON.parse(ls.out).found[0].name).toBe("studio");
  const text = await discoveryCommand.run(["ls"], ctx);
  expect(text.out).toContain("abcdaaaa  studio");
  expect(text.out).toContain("unverified");
  const r = await discoveryCommand.run(["ignore", "abcd"], ctx);
  expect(r.code).toBe(0);
  expect(readState(ctx).silenced[id]).toBe("forever");
});

test("an ambiguous or unknown prefix exits 2", async () => {
  const ctx = setup();
  await recordObservations(ctx, [{ id: "abcd" + "a".repeat(22), name: "one", v: "1", h: "" }, { id: "abce" + "a".repeat(22), name: "two", v: "1", h: "" }], { now: 1, network: home });
  const amb = await discoveryCommand.run(["later", "abc"], ctx);
  expect(amb.code).toBe(2);
  expect(amb.err).toContain("ambiguous");
  const none = await discoveryCommand.run(["pair", "zzz"], ctx);
  expect(none.code).toBe(2);
  expect(none.err).toContain("not found");
});

test("pair without a pairing plugin says so", async () => {
  const ctx = setup();
  await recordObservations(ctx, [{ id: "abcd" + "a".repeat(22), name: "one", v: "1", h: "" }], { now: 1, network: home });
  const r = await discoveryCommand.run(["pair", "abcd"], ctx);
  expect(r.code).toBe(0);
  expect(r.out).toContain("No plugin");
});

test("network and mute-network need a current network; bad usage exits 2; the command is registered", async () => {
  const ctx = setup();
  const net = await discoveryCommand.run(["network", "--json"], ctx);
  expect(net.code).toBe(0);
  expect(JSON.parse(net.out)).toMatchObject({ current: null, networks: [] });
  const set = await discoveryCommand.run(["network", "--advertise", "on"], ctx);
  expect(set.code).toBe(2);
  expect(set.err).toContain("network");
  expect((await discoveryCommand.run(["mute-network"], ctx)).code).toBe(2);
  expect((await discoveryCommand.run(["bogus"], ctx)).code).toBe(2);
  expect((await discoveryCommand.run(["network", "--advertise", "maybe"], ctx)).code).toBe(2);
  expect(findCommand("discovery")).toBe(discoveryCommand);
});

test("network --advertise sends networksRev as expect_rev", async () => {
  const { discoveryCmd } = await import("../src/commands/discovery");
  const calls: [string, any][] = [];
  const view = { rev: 40, networksRev: 3, current: home.key, networks: [{ key: home.key, label: "home", advertise: null, muted: false }] };
  const client = { call: async (op: string, params: any) => { calls.push([op, params]); return view; }, close() {} } as any;
  const r = await discoveryCmd(["network", "--advertise", "on"], setup(), async () => client);
  expect(r.code).toBe(0);
  expect(calls[1]).toEqual(["discovery.network.set", { network: home.key, advertise: true, expect_rev: 3 }]);
});

test("ls names the network once, whether it has an SSID or only the neutral label", async () => {
  const listing = (label: string) => ({ available: true, enabled: true, rev: 1, networksRev: 1, found: [], network: { key: home.key, label, advertise: null, muted: false, name: "pacer-k3x9" } });
  const client = (label: string) => async () => ({ call: async () => listing(label), close() {} }) as never;
  const { discoveryCmd } = await import("../src/commands/discovery");
  const neutral = await discoveryCmd(["ls"], fakeCtx(), client("Network 1dab25"));
  expect(neutral.out.split("\n")[0]).toBe("Network 1dab25: not answered as pacer-k3x9.");
  const ssid = await discoveryCmd(["ls"], fakeCtx(), client("home-wifi"));
  expect(ssid.out.split("\n")[0]).toBe("Network home-wifi: not answered as pacer-k3x9.");
});

test("on and off call discovery.set and work with no strategy.yaml", async () => {
  const ctx = setup();
  const off = await discoveryCommand.run(["off"], ctx);
  expect(off).toMatchObject({ code: 0, out: "Discovery is off." });
  expect(readState(ctx).enabled).toBe(false);
  expect((await discoveryCommand.run(["ls"], ctx)).out).toContain("Discovery is off.");
  const on = await discoveryCommand.run(["on", "--json"], ctx);
  expect(on.code).toBe(0);
  expect(JSON.parse(on.out)).toMatchObject({ enabled: true });
  expect(readState(ctx).enabled).toBe(true);
  expect((await discoveryCommand.run(["on", "now"], ctx)).code).toBe(2);
});

test("on and off send only enabled", async () => {
  const { discoveryCmd } = await import("../src/commands/discovery");
  const calls: [string, any][] = [];
  const client = { call: async (op: string, params: any) => { calls.push([op, params]); return { enabled: params.enabled, rev: 1, networksRev: 1 }; }, close() {} } as any;
  expect((await discoveryCmd(["off"], setup(), async () => client)).code).toBe(0);
  expect(calls).toEqual([["discovery.set", { enabled: false }]]);
});
