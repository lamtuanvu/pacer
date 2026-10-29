import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { base32, fromBase32, rawPublicKey, publicKeyFromRaw } from "../src/identity/encoding";
import { writePrivateFile } from "../src/identity/atomic";

test("base32 round-trips and matches RFC 4648 lowercase without padding", () => {
  expect(base32(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  expect(fromBase32(base32(bytes))).toEqual(bytes);
  expect(base32(bytes)).toHaveLength(52);
});

test("fromBase32 rejects characters outside the alphabet", () => {
  expect(() => fromBase32("abc1")).toThrow();
});

test("raw public key round-trips through KeyObject", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = rawPublicKey(publicKey);
  expect(raw).toHaveLength(32);
  expect(rawPublicKey(publicKeyFromRaw(raw))).toEqual(raw);
});

test("writePrivateFile writes 0600 in a 0700 directory and replaces atomically", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "pacer-id-")), "identity");
  const path = join(dir, "x.json");
  writePrivateFile(path, "one");
  chmodSync(path, 0o644);
  writePrivateFile(path, "two");
  expect(readFileSync(path, "utf8")).toBe("two");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});
