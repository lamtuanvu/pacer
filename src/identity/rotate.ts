import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { appendActivity } from "../activity/log";
import { publish } from "../link/publish";
import { base32, rawPublicKey } from "./encoding";
import { deletePrivateKey, readPrivateKey, writePrivateKey } from "./key-store";
import { clearIdentityCache, loadIdentityLocked, readMeta, withIdentityLock, writeMeta, type MachineMeta } from "./store";
import { signWith, clearTransportKeys } from "./sign";
import { newSalt, readSalt, writeSalt, saltHash } from "./salt";

/** Rotation steps, in order. Each is durable before the next starts; a load after any of them completes or rolls back. */
export type RotationStep = "pending" | "staged" | "swapped" | "salted" | "unstaged" | "committed";
type Pending = NonNullable<MachineMeta["pendingRotation"]>;
interface RotateDeps { platform?: NodeJS.Platform; /** Test hook: called after each durable step. */ afterStep?: (step: RotationStep, newId: string) => void }

const idOf = (key: KeyObject | null) => key ? base32(rawPublicKey(createPublicKey(key))) : null;
/** The message the old key signs: old id, a zero byte, new id. */
export const rotationPayload = (oldId: string, newId: string) => new TextEncoder().encode(`${oldId}\0${newId}`);

/**
 * Replace the machine key. The old key signs the change first, then: record `pendingRotation` in machine.json,
 * store the new key under the staging slot, replace the current key, write a new salt, remove the staged key, and
 * commit machine.json with `lastRotation`. A load that finds `pendingRotation` completes it, or rolls it back when
 * the new key never reached storage. Nothing is announced until the commit.
 * The whole rotation holds the identity lock, so a concurrent rename or rotation in any process starts after it.
 */
export async function rotateIdentity(ctx: Ctx, deps: RotateDeps = {}) {
  if (ctx.readOnly) throw new CoreError("not_allowed", "pacer is read-only here");
  return withIdentityLock(ctx, () => rotateLocked(ctx, deps));
}

async function rotateLocked(ctx: Ctx, deps: RotateDeps) {
  // Re-read from disk: another process may have renamed or rotated since this one cached its identity.
  const old = await loadIdentityLocked(ctx, deps);
  const meta = readMeta(ctx)!;
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const newId = idOf(privateKey)!;
  const salt = newSalt();
  const { signature } = await signWith(ctx, async () => old, "pacer", "rotate", rotationPayload(old.id, newId));
  const pending: Pending = { oldId: old.id, newId, signature: Buffer.from(signature).toString("base64"), stagedAt: ctx.now, saltHash: saltHash(salt) };
  // An afterStep error models the process stopping there, so it is never retried.
  const stops = new WeakSet<object>();
  const step = (s: RotationStep) => { try { deps.afterStep?.(s, newId); } catch (e) { if (e instanceof Object) stops.add(e); throw e; } };
  const undo = async (e: unknown): Promise<never> => {
    try {
      if (idOf(await readPrivateKey(ctx, meta.backend)) !== old.id) await writePrivateKey(ctx, meta.backend, old.privateKey);
      writeMeta(ctx, meta);
    } catch { throw e; } // Leave the pending record; the next load completes the rotation from the staged key.
    await deletePrivateKey(ctx, meta.backend, "staging").catch(() => {});
    throw e;
  };
  writeMeta(ctx, { ...meta, pendingRotation: pending });
  step("pending");
  await writePrivateKey(ctx, meta.backend, privateKey, "staging").catch(undo);
  step("staged");
  await writePrivateKey(ctx, meta.backend, privateKey).catch(undo);
  step("swapped");
  try {
    // The new key is in place, so the rotation can only go forward: retry once, then leave it to the next load.
    try { await commit(ctx, meta, pending, deps.platform, step, salt); }
    catch (e) {
      if (e instanceof Object && stops.has(e)) throw e;
      try { await commit(ctx, meta, pending, deps.platform, step, salt); }
      catch (again) {
        if (again instanceof Object && stops.has(again)) throw again;
        throw new CoreError("unavailable", "The new machine key is in place, but pacer could not finish the rotation. It completes the next time pacer loads the machine identity.",
          "Run pacer machine show to finish it now.", { rotationPending: true, oldId: old.id, newId });
      }
    }
    await announce(ctx, pending);
  } finally { clearIdentityCache(); }
  return { oldId: old.id, newId, signature: pending.signature };
}

/** Finish a rotation whose new key is the current key: store `salt`, remove the staged key, commit machine.json. */
async function commit(ctx: Ctx, meta: MachineMeta, p: Pending, platform: NodeJS.Platform | undefined, step: (s: RotationStep) => void, salt: string): Promise<MachineMeta> {
  clearTransportKeys(ctx);
  await writeSalt(ctx, platform, salt);
  step("salted");
  await deletePrivateKey(ctx, meta.backend, "staging");
  step("unstaged");
  const { cloneDetected: _c, cloneDetectedAt: _at, pendingRotation: _p, ...rest } = meta;
  const next: MachineMeta = { ...rest, rev: meta.rev + 1, publicId: p.newId, rotatedFrom: p.oldId, saltHash: saltHash(salt), lastRotation: { oldId: p.oldId, newId: p.newId, signature: p.signature, at: ctx.now } };
  writeMeta(ctx, next);
  step("committed");
  return next;
}

/** Announce a committed rotation. A stop before this loses the event; `machine.get` still returns the statement. */
async function announce(ctx: Ctx, p: Pending): Promise<void> {
  appendActivity(ctx, { kind: "config", level: "info", text: `Machine identity rotated (${p.oldId.slice(0, 8)} → ${p.newId.slice(0, 8)})` });
  await publish(ctx, [{ type: "entity", data: { kind: "machine", id: "self", value: { event: "rotated", oldId: p.oldId, newId: p.newId, signature: p.signature } } }]);
}

/** Complete an interrupted rotation whose new key was stored, or roll it back. Called by the identity load, under the identity lock. */
export async function recoverRotation(ctx: Ctx, meta: MachineMeta, platform?: NodeJS.Platform): Promise<MachineMeta> {
  const p = meta.pendingRotation!;
  const { pendingRotation: _, ...rest } = meta;
  let salt: string | null = null;
  if (meta.saltHash && !meta.cloneDetected) {
    // A home copied mid-rotation finds no salt under its own tag, or a foreign one. Completing would hand it the
    // source's new key with a fresh salt and no flag, so flag it as copied and drop the rotation instead.
    salt = await readSalt(ctx, platform);
    const hash = salt ? saltHash(salt) : null;
    if (hash !== meta.saltHash && hash !== p.saltHash) {
      const flagged: MachineMeta = { ...rest, cloneDetected: true, cloneDetectedAt: ctx.now };
      writeMeta(ctx, flagged);
      await deletePrivateKey(ctx, meta.backend, "staging");
      return flagged;
    }
    if (hash !== p.saltHash) salt = null;
  }
  if (idOf(await readPrivateKey(ctx, meta.backend)) !== p.newId) {
    const staged = await readPrivateKey(ctx, meta.backend, "staging");
    if (idOf(staged) !== p.newId) {
      writeMeta(ctx, rest);
      await deletePrivateKey(ctx, meta.backend, "staging");
      return rest;
    }
    await writePrivateKey(ctx, meta.backend, staged!);
  }
  const next = await commit(ctx, meta, p, platform, () => {}, salt ?? newSalt());
  await announce(ctx, p);
  return next;
}
