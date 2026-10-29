import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import * as config from "../src/core/config";
import { clearIdentityCache, ensureIdentity, setIdentityPlatformForTests } from "../src/identity/store";
import { buildRadioConfig, recordObservations, radioStatus, resetRadioForTests } from "../src/discovery/radio";
import { discoveryEnabled, readState, updateState, ensureNetwork } from "../src/discovery/state";
import { SILENCE_LATER_S } from "../src/discovery/policy";
import { currentVersion } from "../src/update/version";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); resetRadioForTests(); });
const home = { key: "k1", label: "home-wifi", iface: "en0" };

test("on an unanswered network the radio listens but does not advertise, and the network question is raised", async () => {
  const ctx = fakeCtx();
  expect(radioStatus().available).toBe(false);
  const cfg = await buildRadioConfig(ctx, { network: home });
  expect(cfg).toMatchObject({ enabled: true, listen: true, iface: "en0", advertise: null });
  expect(readState(ctx).networks.k1.advertise).toBeNull();
  expect(radioStatus().available).toBe(true);
});

test("on an approved network the advert has id, name and version but no machine id or user name", async () => {
  const ctx = fakeCtx({ env: { USER: "alex" } });
  await updateState(ctx, s => { ensureNetwork(s, "k1", "home-wifi").advertise = true; });
  const cfg = await buildRadioConfig(ctx, { network: home, hintsFor: () => ({ port: 4433, h: "pk=abc" }) });
  const txt = cfg.advertise!.txt;
  expect(Object.keys(txt).sort()).toEqual(["h", "id", "name", "v"]);
  expect(txt.id).toBe(readState(ctx).networks.k1.discoveryId);
  expect(txt.v).toBe(currentVersion());
  expect(txt.name).toBe((await ensureIdentity(ctx)).name);
  expect(JSON.stringify(cfg)).not.toContain("alex");
  expect(JSON.stringify(cfg)).not.toContain((await ensureIdentity(ctx)).id);
  expect(cfg.advertise!.port).toBe(4433);
  expect(cfg.iface).toBe("en0");
});

test("the config carries the interface's IPv4 address and netmask for the on-link filter", async () => {
  const ctx = fakeCtx();
  const asked: string[] = [];
  const ipv4 = (iface: string) => { asked.push(iface); return { addr: "192.168.1.10", mask: "255.255.255.0" }; };
  expect(await buildRadioConfig(ctx, { network: home, ipv4 })).toMatchObject({ listen: true, iface: "en0", ifaceAddr: "192.168.1.10", ifaceMask: "255.255.255.0" });
  expect(asked).toEqual(["en0"]);
  expect(await buildRadioConfig(ctx, { network: home, ipv4: () => null })).toMatchObject({ iface: "en0", ifaceAddr: null, ifaceMask: null });
  expect(await buildRadioConfig(ctx, { network: null, ipv4 })).toMatchObject({ iface: null, ifaceAddr: null, ifaceMask: null });
  expect(asked).toEqual(["en0"]);
});

test("without plugin hints the advert has no h key and uses the discard port", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { ensureNetwork(s, "k1", "home-wifi").advertise = true; });
  const cfg = await buildRadioConfig(ctx, { network: home });
  expect(Object.keys(cfg.advertise!.txt).sort()).toEqual(["id", "name", "v"]);
  expect(cfg.advertise!.port).toBe(9);
});

test("a declined network listens without advertising", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { ensureNetwork(s, "k1", "home-wifi").advertise = false; });
  expect(await buildRadioConfig(ctx, { network: home })).toMatchObject({ enabled: true, listen: true, advertise: null });
});

test("discovery off disables both listening and advertising, with no strategy.yaml", async () => {
  const ctx = fakeCtx();
  expect(readState(ctx).enabled).toBe(true);
  await updateState(ctx, s => { ensureNetwork(s, "k1", "home-wifi").advertise = true; });
  await updateState(ctx, s => { s.enabled = false; });
  expect(discoveryEnabled(ctx)).toBe(false);
  expect(await buildRadioConfig(ctx, { network: home })).toMatchObject({ enabled: false, listen: false, iface: null, advertise: null });
  await updateState(ctx, s => { s.enabled = true; });
  expect(await buildRadioConfig(ctx, { network: home })).toMatchObject({ enabled: true, listen: true, iface: "en0" });
});

test("discovery is no longer a strategy key; a leftover discovery: off is ignored", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\npacing: {policy: priority}\nrouting: [{default: [codex]}]\ndiscovery: off\n");
  expect((config.CONFIG_KEYS as readonly string[]).includes("discovery")).toBe(false);
  expect(config.get(ctx).keys).not.toHaveProperty("discovery");
  expect(discoveryEnabled(ctx)).toBe(true);
  expect(await buildRadioConfig(ctx, { network: home })).toMatchObject({ enabled: true, listen: true });
  await expect(config.set(ctx, "discovery" as never, "off")).rejects.toThrow();
});

test("an unknown network neither listens nor advertises, and names no interface", async () => {
  const ctx = fakeCtx();
  expect(await buildRadioConfig(ctx, { network: null })).toMatchObject({ enabled: true, listen: false, iface: null, advertise: null });
});

test("observations are sanitized, own adverts are ignored, and prompts respect silences and the hourly cap", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { ensureNetwork(s, "k1", "home-wifi").advertise = true; });
  const own = readState(ctx).networks.k1.discoveryId;
  const now = 1_800_000_000;
  const r1 = await recordObservations(ctx, [
    { id: own, name: "me", v: "3.0.0", h: "" },
    { id: "a".repeat(26), name: "studio\u202e-mac", v: "3.0.0", h: "x" },
    { id: "not valid!", name: "x", v: "1", h: "" },
  ], { now, network: home });
  expect(r1.accepted).toBe(1);
  expect(readState(ctx).seen["a".repeat(26)]).toMatchObject({ name: "studio-mac", network: "k1", firstSeen: now, promptedAt: now });
  expect(r1.prompted).toEqual(["a".repeat(26)]);
  const r2 = await recordObservations(ctx, [{ id: "a".repeat(26), name: "studio-mac", v: "3.0.0", h: "x" }], { now: now + 60, network: home });
  expect(r2.prompted).toEqual([]);
  expect(readState(ctx).seen["a".repeat(26)]).toMatchObject({ firstSeen: now, lastSeen: now + 60 });
  const ids = ["b", "c", "d"].map(ch => ch.repeat(26));
  const r3 = await recordObservations(ctx, ids.map(id => ({ id, name: id.slice(0, 4), v: "1", h: "" })), { now: now + 120, network: home });
  expect(r3.prompted).toHaveLength(2);
  expect(readState(ctx).seen["d".repeat(26)].promptedAt).toBeUndefined();
});

test("a silenced machine raises no prompt", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { s.silenced["f".repeat(26)] = "forever"; s.silenced["g".repeat(26)] = 500; });
  const r = await recordObservations(ctx, ["f", "g"].map(ch => ({ id: ch.repeat(26), name: "x", v: "1", h: "" })), { now: 100, network: home });
  expect(r).toEqual({ accepted: 2, prompted: [] });
});

test("after a Later silence expires, a machine still being seen is prompted again, once per silence period", async () => {
  const ctx = fakeCtx();
  const id = "j".repeat(26), obs = [{ id, name: "studio", v: "1", h: "" }];
  const t0 = 1_800_000_000, later = t0 + 3600;
  expect((await recordObservations(ctx, obs, { now: t0, network: home })).prompted).toEqual([id]);
  await updateState(ctx, s => { s.silenced[id] = later + SILENCE_LATER_S; });
  expect((await recordObservations(ctx, obs, { now: later + SILENCE_LATER_S - 1, network: home })).prompted).toEqual([]);
  const after = later + SILENCE_LATER_S + 1;
  expect((await recordObservations(ctx, obs, { now: after, network: home })).prompted).toEqual([id]);
  expect(readState(ctx).seen[id]).toMatchObject({ firstSeen: t0, promptedAt: after });
  expect((await recordObservations(ctx, obs, { now: after + 60, network: home })).prompted).toEqual([]);
});

test("a re-prompt still counts against the hourly cap", async () => {
  const ctx = fakeCtx();
  const id = "k".repeat(26), obs = [{ id, name: "studio", v: "1", h: "" }];
  const t0 = 1_800_000_000;
  await recordObservations(ctx, obs, { now: t0, network: home });
  const after = t0 + SILENCE_LATER_S + 10;
  await updateState(ctx, s => { s.silenced[id] = after - 1; s.prompts = [after - 30, after - 20, after - 10]; });
  expect((await recordObservations(ctx, obs, { now: after, network: home })).prompted).toEqual([]);
  expect((await recordObservations(ctx, obs, { now: after + 3600, network: home })).prompted).toEqual([id]);
});

test("a machine never answered is not prompted again while its prompt is open", async () => {
  const ctx = fakeCtx();
  const id = "m".repeat(26), obs = [{ id, name: "studio", v: "1", h: "" }];
  await recordObservations(ctx, obs, { now: 1000, network: home });
  expect((await recordObservations(ctx, obs, { now: 1000 + SILENCE_LATER_S - 1, network: home })).prompted).toEqual([]);
});

test("a muted network records machines but raises no prompt", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, s => { ensureNetwork(s, "k1", "home-wifi").muted = true; });
  const r = await recordObservations(ctx, [{ id: "e".repeat(26), name: "x", v: "1", h: "" }], { now: 1, network: home });
  expect(r.accepted).toBe(1);
  expect(r.prompted).toEqual([]);
});

test("the radio endpoints answer only on the internal channel with the internal bearer", async () => {
  const { startServer } = await import("../src/serve/http");
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const internal = "i".repeat(64);
  const s = startServer(() => ctx, { port: 0, pumpMs: 0, internal: { token: internal } });
  try {
    const url = (p: string) => `http://127.0.0.1:${s.port}${p}`;
    const headers = { host: `127.0.0.1:${s.port}`, authorization: `Bearer ${internal}`, "content-type": "application/json" };
    expect((await fetch(url("/_internal/discovery/config"), { method: "POST", headers: { ...headers, authorization: "Bearer wrong" } })).status).toBe(401);
    const cfg = await fetch(url("/_internal/discovery/config"), { method: "POST", headers });
    expect(cfg.status).toBe(200);
    // The fake context identifies no network, so there is no interface to listen on.
    expect(await cfg.json()).toMatchObject({ enabled: true, listen: false, iface: null, ifaceAddr: null, ifaceMask: null, advertise: null });
    const observed = await fetch(url("/_internal/discovery/observed"), { method: "POST", headers, body: JSON.stringify({ observations: [{ id: "h".repeat(26), name: "desk", v: "1", h: "" }, "junk"] }) });
    expect(await observed.json()).toMatchObject({ accepted: 1 });
    expect(readState(ctx).seen["h".repeat(26)].name).toBe("desk");
    const junk = await fetch(url("/_internal/discovery/observed"), { method: "POST", headers, body: "not json" });
    expect(await junk.json()).toEqual({ accepted: 0, prompted: [] });
    const big = await fetch(url("/_internal/discovery/observed"), { method: "POST", headers, body: "x".repeat(300 * 1024) });
    expect(big.status).toBe(413);
  } finally { s.stop(); }
  const open = startServer(() => ctx, { port: 0, pumpMs: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${open.port}/_internal/discovery/config`, { method: "POST", headers: { host: `127.0.0.1:${open.port}`, authorization: `Bearer ${open.token}` } });
    // Outside internal mode the route does not exist; unknown POSTs fall through to the generic 405.
    expect(res.status).toBe(405);
  } finally { open.stop(); }
});
