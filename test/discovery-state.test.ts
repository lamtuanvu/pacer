import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { sanitizeText } from "../src/discovery/sanitize";
import { readState, updateState, ensureNetwork, resetNetworkId, pruneSeen, SEEN_EXPIRE_S, SEEN_MAX } from "../src/discovery/state";

test("sanitizeText strips control and bidi characters and bounds bytes", () => {
  expect(sanitizeText("  studio\u202e-mac\u0007 ", 64)).toBe("studio-mac");
  expect(sanitizeText("é".repeat(40), 10)!.length).toBe(5);
  expect(sanitizeText("😀😀", 5)).toBe("😀");
  expect(sanitizeText(42, 10)).toBeNull();
  expect(sanitizeText("\u0000\u200f", 10)).toBeNull();
});

test("state starts empty and writes 0600 in a 0700 directory", async () => {
  const ctx = fakeCtx();
  expect(readState(ctx)).toMatchObject({ rev: 0, networksRev: 0, networks: {}, seen: {} });
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

test("a stale expected networksRev is a conflict and writes nothing", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, st => { ensureNetwork(st, "k1", "home"); });
  await expect(updateState(ctx, st => { st.networks.k1.advertise = true; }, 0)).rejects.toMatchObject({ code: "conflict" });
  expect(readState(ctx)).toMatchObject({ rev: 1, networksRev: 1, networks: { k1: { advertise: null } } });
  await updateState(ctx, st => { st.silenced.x = "forever"; });
  await updateState(ctx, st => { st.networks.k1.advertise = true; }, 1);
  expect(readState(ctx)).toMatchObject({ rev: 3, networksRev: 2, networks: { k1: { advertise: true } } });
});

test("read-only contexts cannot write discovery state", async () => {
  const ctx = { ...fakeCtx(), readOnly: true };
  await expect(updateState(ctx, () => {})).rejects.toMatchObject({ code: "not_allowed" });
});

test("sanitizeText strips format characters and the tag block but keeps the emoji joiner (N1)", () => {
  expect(sanitizeText("stu­dio⁠⁤\u{E0041}\u{E007F}", 64)).toBe("studio");
  expect(sanitizeText("mac\u{E0000}", 64)).toBe("mac");
  expect(sanitizeText("\u{1F468}‍\u{1F4BB} box", 64)).toBe("\u{1F468}‍\u{1F4BB} box");
});

test("a state file that exists but does not parse turns discovery off and is flagged (N7)", async () => {
  const ctx = fakeCtx();
  await updateState(ctx, st => { st.enabled = true; });
  const path = join(ctx.pacerHome, "discovery", "state.json");
  writeFileSync(path, "{ not json");
  expect(readState(ctx)).toMatchObject({ enabled: false, corrupt: true });
  writeFileSync(path, "[]");
  expect(readState(ctx)).toMatchObject({ enabled: false, corrupt: true });
  // The next write replaces the corrupt file and does not persist the flag.
  await updateState(ctx, st => { st.enabled = true; });
  expect(readState(ctx).enabled).toBe(true);
  expect(readState(ctx).corrupt).toBeUndefined();
  expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("corrupt");
});

const seenAt = (id: string, lastSeen: number, promptedAt?: number) => ({ discoveryId: id, name: id.slice(0, 4), version: "", hints: "", network: "", firstSeen: lastSeen, lastSeen, ...(promptedAt === undefined ? {} : { promptedAt }) });

test("pruneSeen expires machines not seen for 30 days and evicts the oldest beyond the cap, keeping prompted and silenced ones (B2)", () => {
  const now = 100 * 86400;
  const s = readState(fakeCtx());
  s.seen.old = seenAt("old", now - SEEN_EXPIRE_S - 1);
  s.seen.oldsilenced = seenAt("oldsilenced", now - SEEN_EXPIRE_S - 1);
  s.silenced.oldsilenced = "forever";
  for (let i = 0; i < SEEN_MAX + 10; i++) s.seen[`m${i}`] = seenAt(`m${i}`, now - 1000 + i);
  s.seen.prompted = seenAt("prompted", now - 5000, now - 5000);
  s.seen.silenced = seenAt("silenced", now - 6000);
  s.silenced.silenced = now + 100;
  pruneSeen(s, now);
  expect(Object.keys(s.seen).length).toBe(SEEN_MAX);
  expect(s.seen.old).toBeUndefined();
  expect(s.seen.oldsilenced).toBeUndefined();
  expect(s.silenced.oldsilenced).toBe("forever");
  expect(s.seen.prompted).toBeDefined();
  expect(s.seen.silenced).toBeDefined();
  // The oldest unprotected entries went first.
  for (let i = 0; i < 12; i++) expect(s.seen[`m${i}`]).toBeUndefined();
  expect(s.seen[`m${SEEN_MAX + 9}`]).toBeDefined();
});
