import { createPublicKey, generateKeyPairSync } from "node:crypto";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { appendActivity } from "../activity/log";
import { publish } from "../link/publish";
import { base32, rawPublicKey } from "./encoding";
import { writePrivateKey } from "./key-store";
import { clearIdentityCache, ensureIdentity, readMeta, writeMeta } from "./store";
import { signFor, clearTransportKeys } from "./sign";
import { writeSalt, saltHash } from "./salt";

export async function rotateIdentity(ctx: Ctx, deps: { platform?: NodeJS.Platform } = {}) {
  if (ctx.readOnly) throw new CoreError("not_allowed", "pacer is read-only here");
  const old = await ensureIdentity(ctx, deps);
  const { cloneDetected: _c, cloneDetectedAt: _at, ...meta } = readMeta(ctx)!;
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const newId = base32(rawPublicKey(createPublicKey(privateKey)));
  const payload = new TextEncoder().encode(`${old.id}\0${newId}`);
  const { signature } = await signFor(ctx, "pacer", "rotate", payload);
  await writePrivateKey(ctx, meta.backend, privateKey);
  const salt = await writeSalt(ctx, deps.platform);
  writeMeta(ctx, { ...meta, rev: meta.rev + 1, publicId: newId, rotatedFrom: old.id, saltHash: saltHash(salt) });
  clearTransportKeys(ctx);
  clearIdentityCache();
  const result = { oldId: old.id, newId, signature: Buffer.from(signature).toString("base64") };
  appendActivity(ctx, { kind: "config", level: "info", text: `Machine identity rotated (${old.id.slice(0, 8)} → ${newId.slice(0, 8)})` });
  await publish(ctx, [{ type: "entity", data: { kind: "machine", id: "self", value: { event: "rotated", ...result } } }]);
  return result;
}
