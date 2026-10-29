import { beforeEach, expect, test } from "bun:test";
import { verify } from "node:crypto";
import { fakeCtx } from "./helpers";
import { clearIdentityCache, ensureIdentity, setIdentityPlatformForTests } from "../src/identity/store";
import { signFor, verifyFrom, signedMessage, transportKeyPayload, currentTransportKey, clearTransportKeys } from "../src/identity/sign";
import { publicKeyFromRaw, fromBase32 } from "../src/identity/encoding";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });
const bytes = (s: string) => new TextEncoder().encode(s);

test("signed message layout is domain 0 plugin 0 purpose 0 payload", () => {
  expect(signedMessage("demo", "hello", bytes("x")).toString("latin1")).toBe("pacer-machine-sig/v1\0demo\0hello\0x");
});

test("signFor signs the domain-separated message, never the raw payload", async () => {
  const ctx = fakeCtx();
  const id = await ensureIdentity(ctx, { platform: "linux" });
  const { signature, machineId } = await signFor(ctx, "demo", "hello", bytes("payload"));
  expect(machineId).toBe(id.id);
  expect(verifyFrom(machineId, "demo", "hello", bytes("payload"), signature)).toBe(true);
  expect(verify(null, Buffer.from(bytes("payload")), publicKeyFromRaw(fromBase32(machineId)), signature)).toBe(false);
  expect(verifyFrom(machineId, "other", "hello", bytes("payload"), signature)).toBe(false);
  expect(verifyFrom(machineId, "demo", "other", bytes("payload"), signature)).toBe(false);
});

test("purposes must match the plugin id pattern and pacer is reserved", async () => {
  const ctx = fakeCtx();
  await expect(signFor(ctx, "demo", "Bad Purpose", bytes("x"))).rejects.toMatchObject({ code: "invalid_input" });
  await expect(signFor(ctx, "demo", "a\0b", bytes("x"))).rejects.toMatchObject({ code: "invalid_input" });
});

test("a transport-key signature records the current transport key; a new one supersedes it", async () => {
  const ctx = fakeCtx();
  const tk1 = crypto.getRandomValues(new Uint8Array(32));
  const tk2 = crypto.getRandomValues(new Uint8Array(32));
  await signFor(ctx, "demo", "transport-key", transportKeyPayload(tk1));
  const first = currentTransportKey(ctx, "demo");
  await signFor(ctx, "demo", "transport-key", transportKeyPayload(tk2));
  expect(currentTransportKey(ctx, "demo")).not.toBe(first);
  clearTransportKeys(ctx);
  expect(currentTransportKey(ctx, "demo")).toBeNull();
});

test("transport-key purpose requires the fixed payload layout", async () => {
  const ctx = fakeCtx();
  await expect(signFor(ctx, "demo", "transport-key", bytes("not-a-key"))).rejects.toMatchObject({ code: "invalid_input" });
});
