import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { sanitizeText } from "../src/discovery/sanitize";
import { readState, updateState, ensureNetwork, resetNetworkId } from "../src/discovery/state";

test("sanitizeText strips control and bidi characters and bounds bytes", () => {
  expect(sanitizeText("  studio\u202e-mac\u0007 ", 64)).toBe("studio-mac");
  expect(sanitizeText("é".repeat(40), 10)!.length).toBe(5);
  expect(sanitizeText("😀😀", 5)).toBe("😀");
  expect(sanitizeText(42, 10)).toBeNull();
  expect(sanitizeText("\u0000\u200f", 10)).toBeNull();
});

test("state starts empty and writes 0600 in a 0700 directory", async () => {
  const ctx = fakeCtx();
  expect(readState(ctx)).toMatchObject({ rev: 0, networks: {}, seen: {} });
  const s = await updateState(ctx, st => { ensureNetwork(st, "k1", "home"); });
  expect(s.rev).toBe(1);
  const path = join(ctx.pacerHome, "discovery", "state.json");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(ctx.pacerHome, "discovery")).mode & 0o777).toBe(0o700);
  expect(readState(ctx).networks.k1).toMatchObject({ label: "home", advertise: null, muted: false });
});

test("each network gets a random 26-char discovery id; reset makes a new one", async () => {
  const ctx = fakeCtx();
  const s = await updateState(ctx, st => { ensureNetwork(st, "k1", "home"); ensureNetwork(st, "k2", "office"); });
  const a = s.networks.k1.discoveryId, b = s.networks.k2.discoveryId;
  expect(a).toMatch(/^[a-z2-7]{26}$/);
  expect(a).not.toBe(b);
  const t = await updateState(ctx, st => resetNetworkId(st.networks.k1));
  expect(t.networks.k1.discoveryId).not.toBe(a);
});

test("a stale expectRev is a conflict and writes nothing", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, st => { ensureNetwork(st, "k1", "home"); });
  await expect(updateState(ctx, st => { st.networks.k1.advertise = true; }, 0)).rejects.toMatchObject({ code: "conflict" });
  expect(readState(ctx)).toMatchObject({ rev: 1, networks: { k1: { advertise: null } } });
});

test("read-only contexts cannot write discovery state", async () => {
  const ctx = { ...fakeCtx(), readOnly: true };
  await expect(updateState(ctx, () => {})).rejects.toMatchObject({ code: "not_allowed" });
});
