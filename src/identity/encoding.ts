import { createPublicKey, type KeyObject } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** RFC 4648 base32, lowercase, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = "", bits = 0, value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Uint8Array {
  const out: number[] = []; let bits = 0, value = 0;
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Uint8Array.from(out);
}

export function rawPublicKey(key: KeyObject): Uint8Array {
  const der = key.export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - 32));
}

export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error("ed25519 public keys are 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}
