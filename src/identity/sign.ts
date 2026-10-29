import { sign, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { base32, fromBase32, publicKeyFromRaw } from "./encoding";
import { writePrivateFile } from "./atomic";
import { IDENTITY_DIR } from "./key-store";
import { ensureIdentity } from "./store";
import { auditSignature } from "./audit";

export const SIG_DOMAIN = "pacer-machine-sig/v1";
export const PURPOSE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TK_PREFIX = Buffer.from("transport-key/v1\0", "latin1");

export function signedMessage(pluginId: string, purpose: string, payload: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${SIG_DOMAIN}\0${pluginId}\0${purpose}\0`, "latin1"), Buffer.from(payload)]);
}

export function transportKeyPayload(tk: Uint8Array): Uint8Array {
  if (tk.length !== 32) throw new CoreError("invalid_input", "Transport keys are 32 bytes");
  return Buffer.concat([TK_PREFIX, Buffer.from(tk)]);
}

const tkPath = (ctx: Ctx) => join(ctx.pacerHome, IDENTITY_DIR, "transport-keys.json");
function readTks(ctx: Ctx): Record<string, string> {
  return existsSync(tkPath(ctx)) ? JSON.parse(readFileSync(tkPath(ctx), "utf8")) : {};
}

export function currentTransportKey(ctx: Ctx, pluginId: string): string | null { return readTks(ctx)[pluginId] ?? null; }
export function clearTransportKeys(ctx: Ctx): void { writePrivateFile(tkPath(ctx), "{}\n"); }

/** Sign under the domain-separated format. Every signature and every refusal is recorded in the identity audit log. */
export async function signFor(ctx: Ctx, pluginId: string, purpose: string, payload: Uint8Array): Promise<{ signature: Uint8Array; machineId: string }> {
  const refuse = (reason: string, message: string) => {
    auditSignature(ctx, { pluginId, purpose, payload, outcome: "refused", reason });
    return new CoreError("invalid_input", message);
  };
  if (!PURPOSE.test(purpose)) throw refuse("invalid purpose", "Signing purpose must be 2-64 lowercase letters, digits and hyphens");
  if (purpose === "transport-key") {
    const p = Buffer.from(payload);
    if (p.length !== TK_PREFIX.length + 32 || !p.subarray(0, TK_PREFIX.length).equals(TK_PREFIX)) {
      throw refuse("invalid transport-key payload", "transport-key payload must be \"transport-key/v1\" 0x00 followed by a 32-byte key");
    }
  }
  const id = await ensureIdentity(ctx);
  const signature = new Uint8Array(sign(null, signedMessage(pluginId, purpose, payload), id.privateKey));
  auditSignature(ctx, { pluginId, purpose, payload, outcome: "signed", machineId: id.id });
  if (purpose === "transport-key") {
    const tks = readTks(ctx);
    tks[pluginId] = base32(Buffer.from(payload).subarray(TK_PREFIX.length));
    writePrivateFile(tkPath(ctx), JSON.stringify(tks, null, 2) + "\n");
  }
  return { signature, machineId: id.id };
}

export function verifyFrom(machineId: string, pluginId: string, purpose: string, payload: Uint8Array, signature: Uint8Array): boolean {
  try { return verify(null, signedMessage(pluginId, purpose, payload), publicKeyFromRaw(fromBase32(machineId)), Buffer.from(signature)); }
  catch { return false; }
}
