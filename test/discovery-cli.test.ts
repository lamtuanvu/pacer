import { beforeEach, expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { discoveryCommand } from "../src/commands/discovery";
import { findCommand } from "../src/commands";
import { recordObservations, resetRadioForTests } from "../src/discovery/radio";
import { readState } from "../src/discovery/state";
import { clearIdentityCache, setIdentityPlatformForTests } from "../src/identity/store";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); resetRadioForTests(); });
function setup() { const ctx = fakeCtx(); ctx.env.PACER_API = "inprocess"; return ctx; }
const home = { key: "0123456789abcdef0123456789abcdef", label: "home" };

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
