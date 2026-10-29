import { beforeEach, expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { fakeKeychain } from "./fake-keychain";
import { OPS } from "../src/api/ops";
import { clearIdentityCache, ensureIdentity, readMeta, setIdentityPlatformForTests } from "../src/identity/store";
import { cloneSuspected } from "../src/identity/salt";
import { homeTag } from "../src/identity/key-store";
import type { Ctx, RunFn } from "../src/types";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("darwin"); });
const call = (ctx: any, name: string, params: object) => (OPS as any)[name].handler(ctx, (OPS as any)[name].params.parse(params), {});

function counted(run: RunFn) {
  const calls: string[][] = [];
  return { calls, run: ((argv, t, o) => { calls.push([...argv, o?.stdin ?? ""]); return run(argv, t, o); }) as RunFn };
}

test("concurrent first loads in one process share one identity and write one key", async () => {
  const kc = fakeKeychain();
  const c = counted(kc.run);
  const ctx = fakeCtx({ run: c.run });
  const ids = await Promise.all([ensureIdentity(ctx), ensureIdentity(ctx), ensureIdentity(ctx)]);
  expect(new Set(ids.map(i => i.id)).size).toBe(1);
  expect(c.calls.filter(a => a.at(-1)!.includes(`-a machine-identity/${homeTag(ctx)} `)).length).toBe(1);
  clearIdentityCache();
  expect((await ensureIdentity(ctx)).id).toBe(ids[0].id);
  expect(readMeta(ctx)?.publicId).toBe(ids[0].id);
  expect(await cloneSuspected(ctx)).toBe(false);
});

test("a failed load is not cached; the next call tries again", async () => {
  const kc = fakeKeychain();
  const ctx: Ctx = fakeCtx({ run: kc.run });
  kc.fail.write = () => 36;
  const [a, b] = await Promise.allSettled([ensureIdentity(ctx), ensureIdentity(ctx)]);
  expect([a.status, b.status]).toEqual(["rejected", "rejected"]);
  kc.fail.write = undefined;
  expect((await ensureIdentity(ctx)).id).toMatch(/^[a-z2-7]{52}$/);
});

test("machine.get reads the Keychain once and caches the copied-home check with the identity", async () => {
  const kc = fakeKeychain();
  const c = counted(kc.run);
  const ctx = fakeCtx({ run: c.run });
  const first = await call(ctx, "machine.get", {});
  const after = c.calls.length;
  expect(await call(ctx, "machine.get", {})).toEqual(first);
  expect(c.calls.length).toBe(after);
  const renamed = await call(ctx, "machine.set", { name: "studio", expect_rev: first.rev });
  expect(renamed).toMatchObject({ name: "studio", cloneSuspected: false });
  await call(ctx, "machine.rotate", {});
  expect((await call(ctx, "machine.get", {})).cloneSuspected).toBe(false);
});
