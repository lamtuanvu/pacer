import { afterEach, expect, test } from "bun:test";
import { createCallAuthority, type CallAuthority } from "../src/plugins/authority";
import { prepareCredentialBindings, resolveBoundCredential } from "../src/plugins/credential-bindings";
import { fakeCtx } from "./helpers";
const owners: CallAuthority[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.revoke())); });
function owner() {
  const authority = createCallAuthority(fakeCtx({ env: { OWNED_TEST_KEY: "ambient-must-not-read" } }), { reads: [], commands: [], stores: [] }, { deadlineMs: Date.now() + 10000 });
  owners.push(authority); return authority;
}
function barrier() { let done!: () => void; return { promise: new Promise<void>(resolve => { done = resolve; }), finish: () => done() }; }

test("no context permits legacy fallback, explicit empty context denies all references", async () => {
  const a = owner(), b = owner();
  expect(await resolveBoundCredential(a, "env:OWNED_TEST_KEY")).toEqual({ bound: false });
  prepareCredentialBindings(b, []);
  await expect(resolveBoundCredential(b, "env:OWNED_TEST_KEY")).rejects.toMatchObject({ code: "capability_denied" });
});
test("pending reference values never cross owners or mutate ctx/resources", async () => {
  const a = owner(), b = owner(), before = JSON.stringify(a.ctx.env), resources = JSON.stringify(a.resources);
  prepareCredentialBindings(a, [{ ref: "endpoint:pending-owned", resolve: async () => "owned-pending-value" }]);
  prepareCredentialBindings(b, [{ ref: "endpoint:other", resolve: async () => null }]);
  expect(await resolveBoundCredential(a, "endpoint:pending-owned")).toEqual({ bound: true, value: "owned-pending-value" });
  await expect(resolveBoundCredential(b, "endpoint:pending-owned")).rejects.toMatchObject({ code: "capability_denied" });
  expect(await resolveBoundCredential(b, "endpoint:other")).toEqual({ bound: true, value: null });
  expect(JSON.stringify(a.ctx.env)).toBe(before);
  expect(JSON.stringify(a.resources)).toBe(resources);
  expect(JSON.stringify(a.resources)).not.toContain("owned-pending-value");
});
test("prepared descriptors are snapshotted and cannot be widened or replaced", async () => {
  const a = owner();
  const descriptors = [{ ref: "endpoint:owned", resolve: async () => "first" }];
  prepareCredentialBindings(a, descriptors);
  descriptors[0]!.ref = "endpoint:changed";
  descriptors[0]!.resolve = async () => "changed";
  descriptors.push({ ref: "endpoint:extra", resolve: async () => "extra" });
  expect(await resolveBoundCredential(a, "endpoint:owned")).toEqual({ bound: true, value: "first" });
  await expect(resolveBoundCredential(a, "endpoint:extra")).rejects.toMatchObject({ code: "capability_denied" });
  expect(() => prepareCredentialBindings(a, [])).toThrow();
});
test("concurrent and reentrant reads reserve one promise before resolver invocation", async () => {
  const a = owner(), gate = barrier();
  let calls = 0, reentrant: ReturnType<typeof resolveBoundCredential> | undefined;
  prepareCredentialBindings(a, [{ ref: "endpoint:owned", resolve: async () => {
    calls++;
    reentrant = resolveBoundCredential(a, "endpoint:owned");
    await gate.promise;
    return "one-value";
  } }]);
  const first = resolveBoundCredential(a, "endpoint:owned"), second = resolveBoundCredential(a, "endpoint:owned");
  await Bun.sleep(0);
  expect(calls).toBe(1);
  gate.finish();
  expect(await first).toEqual({ bound: true, value: "one-value" });
  expect(await second).toEqual(await reentrant!);
  expect(await resolveBoundCredential(a, "endpoint:owned")).toEqual({ bound: true, value: "one-value" });
  expect(calls).toBe(1);
});
test("revocation before the callback microtask prevents lookup effects", async () => {
  const a = owner(); let calls = 0;
  prepareCredentialBindings(a, [{ ref: "endpoint:owned", resolve: async () => { calls++; return "never"; } }]);
  const read = resolveBoundCredential(a, "endpoint:owned").catch(error => error);
  await a.revoke();
  expect(await read).toMatchObject({ code: "capability_denied" });
  expect(calls).toBe(0);
  await expect(resolveBoundCredential(a, "endpoint:owned")).rejects.toMatchObject({ code: "capability_denied" });
});
test("revocation waits for started lookup and never delivers its late credential", async () => {
  const a = owner(), gate = barrier(), entered = barrier();
  prepareCredentialBindings(a, [{ ref: "endpoint:owned", resolve: async () => { entered.finish(); await gate.promise; return "late-value"; } }]);
  const read = resolveBoundCredential(a, "endpoint:owned").catch(error => error);
  await entered.promise;
  let settled = false;
  const revoked = a.revoke().then(() => { settled = true; });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  await expect(resolveBoundCredential(a, "endpoint:owned")).rejects.toMatchObject({ code: "capability_denied" });
  gate.finish(); await revoked;
  expect(await read).toMatchObject({ code: "capability_denied" });
  expect(JSON.stringify(await read)).not.toContain("late-value");
});
test("resolver errors are fixed, cached and do not reflect callback diagnostics", async () => {
  const a = owner(); let calls = 0;
  prepareCredentialBindings(a, [{ ref: "endpoint:owned", resolve: async () => { calls++; throw Error("secret-resolver-diagnostic"); } }]);
  for (let i = 0; i < 2; i++) {
    const error = await resolveBoundCredential(a, "endpoint:owned").catch(error => error);
    expect(error).toMatchObject({ code: "capability_denied", message: "bound credential could not be resolved" });
    expect(JSON.stringify(error)).not.toContain("secret-resolver-diagnostic");
  }
  expect(calls).toBe(1);
});
test("invalid refs and duplicate declarations are rejected before resolver effects", async () => {
  const a = owner(); let calls = 0;
  const resolve = async () => { calls++; return "never"; };
  for (const ref of ["endpoint:../other", "env:", "endpoint:x\n", "arbitrary:x"]) expect(() => prepareCredentialBindings(a, [{ ref, resolve }])).toThrow();
  expect(() => prepareCredentialBindings(a, [{ ref: "env:A", resolve }, { ref: "env:A", resolve }])).toThrow();
  prepareCredentialBindings(a, []);
  expect(calls).toBe(0);
});
