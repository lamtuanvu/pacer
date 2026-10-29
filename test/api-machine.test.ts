import { beforeEach, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { fakeCtx } from "./helpers";
import { fakeKeychain } from "./fake-keychain";
import { OPS } from "../src/api/ops";
import { toV2Event, v2Hello, V3_ONLY_OPS } from "../src/api/v2-compat";
import { renderProtocolDoc } from "../scripts/protocol-doc";
import { verifyFrom } from "../src/identity/sign";
import { clearIdentityCache, readMeta, setIdentityPlatformForTests } from "../src/identity/store";
import { assertCallerCanInvoke } from "../src/api/caller-policy";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });
const call = (ctx: any, name: string, params: object) => (OPS as any)[name].handler(ctx, (OPS as any)[name].params.parse(params), {});

test("machine.get returns id, name, rev and clone status without key material", async () => {
  const ctx = fakeCtx();
  const view = await call(ctx, "machine.get", {});
  expect(Object.keys(view).sort()).toEqual(["cloneSuspected", "id", "name", "rev"]);
  expect(view.cloneSuspected).toBe(false);
  expect(JSON.stringify(view)).not.toMatch(/PRIVATE|pkcs8/i);
});

test("machine.set renames with expect_rev and returns the new rev", async () => {
  const ctx = fakeCtx();
  const a = await call(ctx, "machine.get", {});
  const b = await call(ctx, "machine.set", { name: "studio-mac", expect_rev: a.rev });
  expect(b).toMatchObject({ id: a.id, name: "studio-mac", rev: a.rev + 1 });
  await expect(call(ctx, "machine.set", { name: "x", expect_rev: a.rev })).rejects.toMatchObject({ code: "conflict" });
});

test("machine.rotate returns old and new ids only", async () => {
  const ctx = fakeCtx();
  const before = await call(ctx, "machine.get", {});
  const r = await call(ctx, "machine.rotate", {});
  expect(Object.keys(r).sort()).toEqual(["newId", "oldId"]);
  expect(r.oldId).toBe(before.id);
  expect((await call(ctx, "machine.get", {})).id).toBe(r.newId);
});

test("machine ops are v3 only", () => {
  for (const name of ["machine.get", "machine.set", "machine.rotate"]) expect(V3_ONLY_OPS.has(name)).toBe(true);
});

test("machine events and machine config events are v3 only", () => {
  const rotated = { seq: 5, at: 1, type: "machine" as const, data: { kind: "machine", id: "self", value: { event: "rotated", oldId: "a", newId: "b", signature: "c" } } };
  expect(toV2Event(rotated)).toBeNull();
  expect(toV2Event({ seq: 6, at: 1, type: "config", data: { area: "machine", at: 1 } })).toBeNull();
  expect(toV2Event({ seq: 7, at: 1, type: "config", data: { area: "plugins", at: 1 } })).toMatchObject({ type: "config" });
  expect(v2Hello().events).not.toContain("machine");
  const v2 = renderProtocolDoc(2), v3 = renderProtocolDoc(3);
  expect(v2).not.toMatch(/event types are [^.]*`machine`/);
  expect(v2).not.toContain("`rotated`");
  expect(v3).toMatch(/event types are [^.]*`machine`/);
  expect(v3).toMatch(/`area` is one of [^)]*`machine`/);
  expect(v3).toContain('"pacer-machine-sig/v1" 0x00 "pacer" 0x00 "rotate" 0x00 oldId 0x00 newId');
});

test("machine.get exposes the signed statement of the last rotation", async () => {
  const ctx = fakeCtx();
  const r = await call(ctx, "machine.rotate", {});
  const view = await call(ctx, "machine.get", {});
  expect(view).toMatchObject({ id: r.newId, rotatedFrom: r.oldId });
  const payload = new TextEncoder().encode(`${r.oldId}\0${r.newId}`);
  expect(verifyFrom(r.oldId, "pacer", "rotate", payload, Buffer.from(view.rotationSignature, "base64"))).toBe(true);
  clearIdentityCache();
  expect(await call(ctx, "machine.get", {})).toEqual(view);
});

test("executor sessions cannot rename or rotate", () => {
  const ctx = fakeCtx(); ctx.env.PACER_ROLE = "executor";
  expect(() => assertCallerCanInvoke(ctx, "machine.set", {})).toThrow();
  expect(() => assertCallerCanInvoke(ctx, "machine.rotate", {})).toThrow();
  expect(() => assertCallerCanInvoke(ctx, "machine.get", {})).not.toThrow();
});

test("machine.get reports a home copied to a new path on the keychain backend and keeps it working", async () => {
  setIdentityPlatformForTests("darwin");
  const kc = fakeKeychain();
  const a = fakeCtx({ run: kc.run });
  const original = await call(a, "machine.set", { name: "studio-mac", expect_rev: (await call(a, "machine.get", {})).rev });
  clearIdentityCache();
  const copy = fakeCtx({ run: kc.run });
  cpSync(a.pacerHome, copy.pacerHome, { recursive: true });
  const view = await call(copy, "machine.get", {});
  expect(view.cloneSuspected).toBe(true);
  expect(view).toMatchObject({ name: "studio-mac", rev: original.rev + 1 });
  expect(view.id).not.toBe(original.id);
  expect(readMeta(copy)).toMatchObject({ cloneDetected: true, cloneDetectedAt: copy.now, publicId: view.id });
  clearIdentityCache();
  expect((await call(copy, "machine.get", {})).cloneSuspected).toBe(true);
  expect(await call(copy, "machine.set", { name: "copy", expect_rev: view.rev })).toMatchObject({ cloneSuspected: true });
  clearIdentityCache();
  expect(await call(a, "machine.get", {})).toMatchObject({ id: original.id, cloneSuspected: false });
});

test("machine.get reports a copied home on the file backend whose salt is missing", async () => {
  const a = fakeCtx();
  const original = await call(a, "machine.get", {});
  clearIdentityCache();
  const copy = fakeCtx();
  cpSync(a.pacerHome, copy.pacerHome, { recursive: true });
  const view = await call(copy, "machine.get", {});
  expect(view).toMatchObject({ id: original.id, cloneSuspected: true });
  expect(readMeta(copy)).toMatchObject({ cloneDetected: true, cloneDetectedAt: copy.now });
});

test("machine.rotate clears a detected copy", async () => {
  setIdentityPlatformForTests("darwin");
  const kc = fakeKeychain();
  const a = fakeCtx({ run: kc.run });
  await call(a, "machine.get", {});
  clearIdentityCache();
  const copy = fakeCtx({ run: kc.run });
  cpSync(a.pacerHome, copy.pacerHome, { recursive: true });
  expect((await call(copy, "machine.get", {})).cloneSuspected).toBe(true);
  await call(copy, "machine.rotate", {});
  expect((await call(copy, "machine.get", {})).cloneSuspected).toBe(false);
  expect(readMeta(copy)?.cloneDetected).toBeUndefined();
});
