import { beforeEach, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { fakeCtx } from "./helpers";
import { clearIdentityCache, ensureIdentity, setIdentityPlatformForTests } from "../src/identity/store";
import { cloneSuspected, saltPath } from "../src/identity/salt";
import { rotateIdentity } from "../src/identity/rotate";
import { verifyFrom, signFor, transportKeyPayload, currentTransportKey } from "../src/identity/sign";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });

test("a fresh identity is not suspected as a clone and the salt lives outside PACER_HOME", async () => {
  const ctx = fakeCtx();
  await ensureIdentity(ctx, { platform: "linux" });
  expect(await cloneSuspected(ctx, "linux")).toBe(false);
  expect(saltPath(ctx).startsWith(ctx.pacerHome)).toBe(false);
  expect(statSync(saltPath(ctx)).mode & 0o777).toBe(0o600);
});

test("a copied home without the salt is suspected as a clone", async () => {
  const ctx = fakeCtx();
  await ensureIdentity(ctx, { platform: "linux" });
  rmSync(saltPath(ctx));
  expect(await cloneSuspected(ctx, "linux")).toBe(true);
});

test("rotation makes a new id, signs the change with the old key and clears transport keys", async () => {
  const ctx = fakeCtx();
  const before = await ensureIdentity(ctx, { platform: "linux" });
  await signFor(ctx, "demo", "transport-key", transportKeyPayload(crypto.getRandomValues(new Uint8Array(32))));
  const r = await rotateIdentity(ctx, { platform: "linux" });
  expect(r.oldId).toBe(before.id);
  expect(r.newId).not.toBe(before.id);
  const payload = new TextEncoder().encode(`${r.oldId}\0${r.newId}`);
  expect(verifyFrom(r.oldId, "pacer", "rotate", payload, Buffer.from(r.signature, "base64"))).toBe(true);
  expect(currentTransportKey(ctx, "demo")).toBeNull();
  expect((await ensureIdentity(ctx, { platform: "linux" })).id).toBe(r.newId);
  expect(await cloneSuspected(ctx, "linux")).toBe(false);
});
