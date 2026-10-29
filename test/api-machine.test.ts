import { beforeEach, expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { OPS } from "../src/api/ops";
import { V3_ONLY_OPS } from "../src/api/v2-compat";
import { clearIdentityCache, setIdentityPlatformForTests } from "../src/identity/store";
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

test("executor sessions cannot rename or rotate", () => {
  const ctx = fakeCtx(); ctx.env.PACER_ROLE = "executor";
  expect(() => assertCallerCanInvoke(ctx, "machine.set", {})).toThrow();
  expect(() => assertCallerCanInvoke(ctx, "machine.rotate", {})).toThrow();
  expect(() => assertCallerCanInvoke(ctx, "machine.get", {})).not.toThrow();
});
