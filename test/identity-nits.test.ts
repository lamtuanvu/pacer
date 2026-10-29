import { beforeEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeCtx } from "./helpers";
import { fakeKeychain } from "./fake-keychain";
import { base32, fromBase32, parseMachineId } from "../src/identity/encoding";
import { writePrivateFile } from "../src/identity/atomic";
import { clearIdentityCache, ensureIdentity, sanitizeName, setIdentityPlatformForTests } from "../src/identity/store";
import { currentTransportKey, signFor, transportKeyPayload, verifyFrom } from "../src/identity/sign";
import { CAPABILITY_METHODS, manifestSchema } from "../src/plugins/protocol";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });

test("names drop the Arabic letter mark, line and paragraph separators and zero-width characters", () => {
  expect(sanitizeName("a\u061Cb\u2028c\u2029d\u200Be\u200Cf\u200Dg\uFEFFh")).toBe("abcdefgh");
});

test("names are cut at 64 code points, never inside a surrogate pair", () => {
  const name = sanitizeName("😀".repeat(70));
  expect([...name]).toHaveLength(64);
  expect(name).toBe("😀".repeat(64));
});

test("machine ids are canonical base32: 52 characters and zero trailing bits", () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const id = base32(raw);
  expect(parseMachineId(id)).toEqual(raw);
  const last = "abcdefghijklmnopqrstuvwxyz234567".indexOf(id.at(-1)!);
  const alias = id.slice(0, -1) + "abcdefghijklmnopqrstuvwxyz234567"[last | 1];
  expect(() => fromBase32(alias)).toThrow();
  expect(() => parseMachineId(id.slice(0, 51))).toThrow();
  expect(() => parseMachineId(id + "a")).toThrow();
});

test("a signature does not verify under a non-canonical spelling of the id", async () => {
  const ctx = fakeCtx();
  const { signature, machineId } = await signFor(ctx, "demo", "hello", new Uint8Array([1]));
  const last = "abcdefghijklmnopqrstuvwxyz234567".indexOf(machineId.at(-1)!);
  const alias = machineId.slice(0, -1) + "abcdefghijklmnopqrstuvwxyz234567"[last | 1];
  expect(verifyFrom(machineId, "demo", "hello", new Uint8Array([1]), signature)).toBe(true);
  expect(verifyFrom(alias, "demo", "hello", new Uint8Array([1]), signature)).toBe(false);
});

test("identity.sign payloads must be canonical base64", () => {
  const params = CAPABILITY_METHODS["capability.identity.sign"]!.params;
  expect(params.safeParse({ purpose: "greeting", payload: "YQ==" }).success).toBe(true);
  expect(params.safeParse({ purpose: "greeting", payload: "" }).success).toBe(true);
  for (const payload of ["YQ", "YR==", "YQ=", "Y"]) expect(params.safeParse({ purpose: "greeting", payload }).success).toBe(false);
});

test("identity.sign scopes must be valid purposes at install", () => {
  const manifest = (scopes: string[]) => ({ id: "demo", version: "1.0.0", publisher: "t", host: ">=1.4.0", capabilities: [{ name: "identity.sign", scopes }] });
  expect(() => manifestSchema.parse(manifest(["greeting", "transport-key"]))).not.toThrow();
  for (const bad of ["Bad Scope", "a", "a\u0000b", "-x"]) expect(() => manifestSchema.parse(manifest([bad]))).toThrow(/purpose/);
});

test("the identity.sign deadline allows a cold Keychain load", () => {
  expect(CAPABILITY_METHODS["capability.identity.sign"]!.deadlineMs).toBe(15000);
});

test("a new key made for a copied home forgets the transport keys certified by the source machine's key", async () => {
  setIdentityPlatformForTests("darwin");
  const kc = fakeKeychain();
  const a = fakeCtx({ run: kc.run });
  await signFor(a, "demo", "transport-key", transportKeyPayload(new Uint8Array(32).fill(3)));
  expect(currentTransportKey(a, "demo")).not.toBeNull();
  clearIdentityCache();
  const copy = fakeCtx({ run: kc.run });
  cpSync(a.pacerHome, copy.pacerHome, { recursive: true });
  await ensureIdentity(copy);
  expect(currentTransportKey(copy, "demo")).toBeNull();
  expect(currentTransportKey(a, "demo")).not.toBeNull();
});

test("writePrivateFile writes all of a large buffer", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pacer-id-")), "identity", "big");
  const data = crypto.getRandomValues(new Uint8Array(65536)).map((b, i) => (b + i) & 255);
  writePrivateFile(path, data);
  expect(new Uint8Array(readFileSync(path))).toEqual(data);
});
