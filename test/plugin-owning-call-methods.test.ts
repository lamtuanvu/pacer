import { expect, test } from "bun:test";
import { answerCapability } from "../src/plugins/host";
import { CAPABILITY_METHODS, capabilityOf, type PluginManifest } from "../src/plugins/protocol";
import fixture from "./fixtures/owning-call-methods.json";
import { fakeCtx } from "./helpers";

// The native owner refuses the same methods outside an owning call
// (crates/plugin-runtime/tests/owning_call_authority.rs reads this fixture).
test("the owning-call fixture matches every method TypeScript answers only inside an owning call", async () => {
  const ctx = fakeCtx(), scoped: Record<string, string> = {}, unscoped: Record<string, string> = {};
  for (const method of Object.keys(CAPABILITY_METHODS).sort()) {
    const name = capabilityOf(method)!;
    if (name === "tasks.read" || name === "events.subscribe") continue;
    const manifest: PluginManifest = { id: "fixture", publisher: "test", version: "0.2.0", host: "^1.6", contributes: { usage: {} }, tier: "free", reentrant: false, capabilities: [{ name } as PluginManifest["capabilities"][number]] };
    const refusal = await answerCapability(ctx, { id: "fixture", manifest }, method, 42).then(() => undefined, (error: { code?: string; message?: string }) => error);
    if (refusal?.message === fixture.refusal) {
      expect(refusal.code).toBe("capability_denied");
      scoped[method] = name;
    } else unscoped[method] = name;
  }
  expect(scoped).toEqual(fixture.scoped);
  expect(unscoped).toEqual(fixture.unscoped);
});
