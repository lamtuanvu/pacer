import { beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { OPS } from "../src/api/ops";
import { clearIdentityCache, setIdentityPlatformForTests } from "../src/identity/store";
import { recordObservations, resetRadioForTests } from "../src/discovery/radio";
import { updateState, ensureNetwork, readState } from "../src/discovery/state";
import { FOUND_MAX } from "../src/api/ops-discovery";
import { assertCallerCanInvoke } from "../src/api/caller-policy";
import { V3_ONLY_OPS, v2Hello } from "../src/api/v2-compat";
import { helloBody } from "../src/api/protocol";
import { eventsSince } from "../src/api/events";
import { parseOutboxEvent } from "../src/link/envelope";
import { readOutboxSince } from "../src/link/store";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); resetRadioForTests(); });
const call = (ctx: any, name: string, params: object) => (OPS as any)[name].handler(ctx, (OPS as any)[name].params.parse(params), {});
const K1 = "0123456789abcdef0123456789abcdef";
const home = { key: K1, label: "home-wifi", iface: "en0" };
const peer = "a".repeat(26);

test("discovery.list reports unavailable when no radio has called in", async () => {
  const r = await call(fakeCtx(), "discovery.list", {});
  expect(r.available).toBe(false);
  expect(r.enabled).toBe(true);
  expect(r.found).toEqual([]);
});

test("discovery.list shows found machines with their silence state", async () => {
  const ctx = fakeCtx();
  await recordObservations(ctx, [{ id: peer, name: "studio", v: "1", h: "" }], { now: 100, network: home });
  const r = await call(ctx, "discovery.list", {});
  expect(r.found).toEqual([{ discoveryId: peer, name: "studio", version: "1", lastSeen: 100, silenced: false }]);
  expect(r.rev).toBe(readState(ctx).rev);
  expect(r.networksRev).toBe(readState(ctx).networksRev);
});

test("later silences for 7 days, ignore forever, mute-network stops prompts", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { ensureNetwork(s, K1, "home-wifi").advertise = true; });
  await recordObservations(ctx, [{ id: peer, name: "studio", v: "1", h: "" }], { now: 100, network: home });
  await call(ctx, "discovery.respond", { discoveryId: peer, action: "later" });
  expect(typeof readState(ctx).silenced[peer]).toBe("number");
  await call(ctx, "discovery.respond", { discoveryId: peer, action: "ignore" });
  expect(readState(ctx).silenced[peer]).toBe("forever");
  await call(ctx, "discovery.respond", { discoveryId: peer, action: "mute-network" });
  expect(readState(ctx).networks[K1].muted).toBe(true);
});

test("respond to an unknown machine is not_found", async () => {
  await expect(call(fakeCtx(), "discovery.respond", { discoveryId: peer, action: "later" })).rejects.toMatchObject({ code: "not_found" });
});

test("pair with no pairing plugin returns handedOver false", async () => {
  const ctx = fakeCtx();
  await recordObservations(ctx, [{ id: peer, name: "studio", v: "1", h: "" }], { now: 100, network: home });
  const r = await call(ctx, "discovery.respond", { discoveryId: peer, action: "pair" });
  expect(r.pairing).toEqual({ handedOver: false });
});

test("network.set checks expect_rev against networksRev and can reset the discovery id", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { ensureNetwork(s, K1, "home-wifi"); });
  const before = readState(ctx);
  const r = await call(ctx, "discovery.network.set", { network: K1, advertise: true, resetId: true, expect_rev: before.networksRev });
  expect(r.networks.find((n: any) => n.key === K1).advertise).toBe(true);
  expect(r.networksRev).toBe(before.networksRev + 1);
  expect(readState(ctx).networks[K1].discoveryId).not.toBe(before.networks[K1].discoveryId);
  await expect(call(ctx, "discovery.network.set", { network: K1, advertise: false, expect_rev: before.networksRev })).rejects.toMatchObject({ code: "conflict" });
  const got = await call(ctx, "discovery.network.get", {});
  expect(got).toMatchObject({ rev: readState(ctx).rev, networksRev: readState(ctx).networksRev, current: null, networks: [{ key: K1, label: "home-wifi", advertise: true, muted: false }] });
});

test("observations between reading and clicking Allow do not make Allow stale", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { ensureNetwork(s, K1, "home-wifi"); });
  const read = await call(ctx, "discovery.network.get", {});
  await recordObservations(ctx, [{ id: peer, name: "studio", v: "1", h: "" }], { now: 100, network: home });
  await recordObservations(ctx, [{ id: peer, name: "studio", v: "1", h: "" }], { now: 200, network: home });
  await call(ctx, "discovery.respond", { discoveryId: peer, action: "later" });
  expect(readState(ctx).rev).toBeGreaterThan(read.rev);
  const r = await call(ctx, "discovery.network.set", { network: K1, advertise: true, expect_rev: read.networksRev });
  expect(r.networks[0].advertise).toBe(true);
});

test("networksRev moves only when network entries change", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { ensureNetwork(s, K1, "home-wifi"); });
  const start = readState(ctx).networksRev;
  expect(start).toBe(1);
  await updateState(ctx, s => { s.silenced[peer] = "forever"; s.prompts.push(1); });
  expect(readState(ctx).networksRev).toBe(start);
  await updateState(ctx, s => { ensureNetwork(s, K1, "home-wifi"); });
  expect(readState(ctx).networksRev).toBe(start);
  await updateState(ctx, s => { s.networks[K1].muted = true; });
  expect(readState(ctx).networksRev).toBe(start + 1);
});

test("executor sessions cannot respond, change networks or turn discovery on or off", () => {
  const ctx = { ...fakeCtx(), env: { PACER_ROLE: "executor" } } as any;
  expect(() => assertCallerCanInvoke(ctx, "discovery.set", { enabled: false })).toThrow(expect.objectContaining({ code: "not_allowed" }));
  expect(() => assertCallerCanInvoke(ctx, "discovery.respond", {})).toThrow();
  expect(() => assertCallerCanInvoke(ctx, "discovery.network.set", {})).toThrow();
  expect(() => assertCallerCanInvoke(ctx, "discovery.list", {})).not.toThrow();
  expect(() => assertCallerCanInvoke(ctx, "discovery.network.get", {})).not.toThrow();
});

test("discovery ops and the discovery.found event are v3-only", () => {
  for (const op of ["discovery.list", "discovery.set", "discovery.respond", "discovery.network.get", "discovery.network.set"]) expect(V3_ONLY_OPS.has(op)).toBe(true);
  expect(helloBody().events).toContain("discovery.found");
  expect(v2Hello().events).not.toContain("discovery.found");
});

test("a prompted machine publishes discovery.found to v3 clients only", async () => {
  const ctx = fakeCtx();
  await recordObservations(ctx, [{ id: peer, name: "studio", v: "1.2", h: "" }], { now: 100, network: home });
  const found = readOutboxSince(ctx, 0).filter(e => e.envelope.type === "discovery.found");
  expect(found.map(e => e.envelope.data)).toEqual([{ discoveryId: peer, name: "studio", version: "1.2" }]);
  expect(eventsSince(ctx, 0, 3).events.filter(e => e.type === "discovery.found").map(e => e.data)).toEqual([{ discoveryId: peer, name: "studio", version: "1.2" }]);
  expect(eventsSince(ctx, 0, 2).events.some(e => e.type === "discovery.found")).toBe(false);
  // Seen again: no second event.
  await recordObservations(ctx, [{ id: peer, name: "studio", v: "1.2", h: "" }], { now: 200, network: home });
  expect(readOutboxSince(ctx, 0).filter(e => e.envelope.type === "discovery.found").length).toBe(1);
});

test("the discovery.found parser bounds and rejects malformed data", () => {
  expect(parseOutboxEvent({ type: "discovery.found", data: { discoveryId: peer, name: "x".repeat(500), version: "1" } }))
    .toEqual({ type: "discovery.found", data: { discoveryId: peer, name: "x".repeat(64), version: "1" } });
  expect(parseOutboxEvent({ type: "discovery.found", data: { discoveryId: "nope", name: "x", version: "1" } })).toBeNull();
  expect(parseOutboxEvent({ type: "discovery.found", data: null })).toBeNull();
});

test("v2 clients get no discovery config changes or discovery attention", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { ensureNetwork(s, K1, "home-wifi"); });
  await call(ctx, "discovery.network.set", { network: K1, advertise: true, expect_rev: readState(ctx).networksRev });
  const { publish } = await import("../src/link/publish");
  await publish(ctx, [{ type: "entity", data: { kind: "attention", id: `discovery:${peer}`, value: { id: `discovery:${peer}`, kind: "discovery" } } }]);
  expect(eventsSince(ctx, 0, 3).events.some(e => e.type === "config" && (e.data as any).area === "discovery")).toBe(true);
  const v2 = eventsSince(ctx, 0, 2).events;
  expect(v2.some(e => e.type === "config" && (e.data as any).area === "discovery")).toBe(false);
  expect(v2.some(e => e.type === "attention")).toBe(false);
});

test("discovery.set turns discovery off and on with no strategy.yaml and publishes a discovery config change", async () => {
  const ctx = fakeCtx();
  expect(existsSync(join(ctx.pacerHome, "strategy.yaml"))).toBe(false);
  const start = readState(ctx).networksRev;
  const off = await call(ctx, "discovery.set", { enabled: false });
  expect(off).toMatchObject({ enabled: false, networksRev: start + 1 });
  expect(readState(ctx).enabled).toBe(false);
  expect((await call(ctx, "discovery.list", {})).enabled).toBe(false);
  expect(eventsSince(ctx, 0, 3).events.some(e => e.type === "config" && (e.data as any).area === "discovery")).toBe(true);
  expect(existsSync(join(ctx.pacerHome, "strategy.yaml"))).toBe(false);
  const on = await call(ctx, "discovery.set", { enabled: true, expect_rev: start + 1 });
  expect(on).toMatchObject({ enabled: true, networksRev: start + 2 });
  expect((await call(ctx, "discovery.list", {})).enabled).toBe(true);
});

test("discovery.set with a stale expect_rev is a conflict and writes nothing; setting the same value keeps networksRev", async () => {
  const ctx = fakeCtx();
  await call(ctx, "discovery.set", { enabled: false });
  await expect(call(ctx, "discovery.set", { enabled: true, expect_rev: 0 })).rejects.toMatchObject({ code: "conflict" });
  expect(readState(ctx).enabled).toBe(false);
  const rev = readState(ctx).networksRev;
  await call(ctx, "discovery.set", { enabled: false });
  expect(readState(ctx).networksRev).toBe(rev);
  expect(() => (OPS as any)["discovery.set"].params.parse({ enabled: "off" })).toThrow();
});

test("discovery.list caps found at the most recently seen machines (B2)", async () => {
  const ctx = fakeCtx();
  const B32 = "abcdefghijklmnopqrstuvwxyz234567";
  const idOf = (n: number) => Array.from({ length: 26 }, (_, i) => B32[Math.floor(n / 32 ** i) % 32]).join("");
  for (let b = 0; b < 3; b++) await recordObservations(ctx, Array.from({ length: 64 }, (_, i) => ({ id: idOf(b * 64 + i), name: "x", v: "1", h: "" })), { now: 100 + b, network: home });
  const r = await call(ctx, "discovery.list", {});
  expect(r.found.length).toBe(FOUND_MAX);
  expect(r.found[0].lastSeen).toBe(102);
  expect(r.found.at(-1).lastSeen).toBeGreaterThanOrEqual(101);
});

test("discovery.list reports a corrupt state file as off with a warning (N7)", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { s.enabled = true; });
  writeFileSync(join(ctx.pacerHome, "discovery", "state.json"), "{");
  const r = await call(ctx, "discovery.list", {});
  expect(r.enabled).toBe(false);
  expect(r.warning).toContain("could not be read");
});

test("while the state file is corrupt only discovery.set writes; the warning stays until then (N12)", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { ensureNetwork(s, K1, "home-wifi"); });
  const path = join(ctx.pacerHome, "discovery", "state.json");
  writeFileSync(path, "{");
  await expect(call(ctx, "discovery.network.set", { network: K1, advertise: true, expect_rev: 0 })).rejects.toMatchObject({ code: "conflict" });
  expect(await recordObservations(ctx, [{ id: peer, name: "x", v: "1", h: "" }], { now: 1, network: home })).toEqual({ accepted: 0, prompted: [] });
  expect((await call(ctx, "discovery.list", {})).warning).toContain("could not be read");
  await call(ctx, "discovery.set", { enabled: false });
  const r = await call(ctx, "discovery.list", {});
  expect(r.warning).toBeUndefined();
  expect(r.enabled).toBe(false);
});

test("v2 clients get no discovery notifications; other notifications pass (S2)", async () => {
  const ctx = fakeCtx();
  const { publish } = await import("../src/link/publish");
  const notify = (key: string) => ({ type: "entity" as const, data: { kind: "notify" as const, id: key, value: { key, title: key, body: "", actions: [], url: "/app/#/" } } });
  await publish(ctx, [notify(`discovery:${peer}:100`), notify(`discovery-network:${K1}:100`), notify("review:t-1:100")]);
  expect(eventsSince(ctx, 0, 3).events.filter(e => e.type === "notify").length).toBe(3);
  expect(eventsSince(ctx, 0, 2).events.filter(e => e.type === "notify").map(e => (e.data as any).key)).toEqual(["review:t-1:100"]);
});

test("v2 counts events leave out the open discovery items (S2)", async () => {
  const ctx = fakeCtx();
  const { publish } = await import("../src/link/publish");
  const attention = (id: string, removed = false) => ({ type: "entity" as const, data: removed ? { kind: "attention" as const, id, removed: true as const } : { kind: "attention" as const, id, value: { id } } });
  const counts = (n: number) => ({ type: "entity" as const, data: { kind: "counts" as const, id: "counts", value: { attention: n, problems: 1, review: 0 } } });
  await publish(ctx, [attention(`discovery:${peer}`), attention(`discovery-network:${K1}`), attention("failed:t-1"), counts(3)]);
  await publish(ctx, [attention(`discovery-network:${K1}`, true), counts(2)]);
  const v3 = eventsSince(ctx, 0, 3).events.filter(e => e.type === "counts").map(e => (e.data as any).attention);
  expect(v3).toEqual([3, 2]);
  const v2 = eventsSince(ctx, 0, 2).events.filter(e => e.type === "counts").map(e => e.data as any);
  expect(v2.map(c => c.attention)).toEqual([1, 1]);
  expect(v2.map(c => c.problems)).toEqual([1, 1]);
  // Reading from a later cursor still knows which discovery items are open.
  const last = eventsSince(ctx, 0, 2).events.at(-1)!.seq;
  expect(eventsSince(ctx, last - 1, 2).events.filter(e => e.type === "counts").map(e => (e.data as any).attention)).toEqual([1]);
});

test("the v2 fallback alerts leave out discovery items (S2)", async () => {
  const { fixture } = await import("./fixtures/protocol-v2/capture");
  const { liveSnapshot } = await import("../src/api/events");
  const { toV2Snapshot } = await import("../src/api/v2-compat");
  const { ctx, status } = await fixture();
  const wire = JSON.parse(JSON.stringify((await liveSnapshot(ctx, { status: async () => status })).snapshot));
  wire.attention.push({ id: `discovery:${peer}`, kind: "discovery", severity: "decide", title: "Found pacer on studio", detail: "", actions: [], raisedAt: 1 });
  const v2 = toV2Snapshot(wire);
  expect(v2.alerts.some(a => a.key.startsWith("discovery"))).toBe(false);
  expect(v2.alerts.length).toBe(wire.attention.length - 1);
});
