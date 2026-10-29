import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fakeCtx } from "./helpers";
import { answerCapability, pluginLogPath } from "../src/plugins/host";
import { manifestSchema, PLUGIN_PROTOCOL_VERSION } from "../src/plugins/protocol";
import { currentTransportKey, transportKeyPayload, verifyFrom } from "../src/identity/sign";
import { clearIdentityCache, setIdentityPlatformForTests } from "../src/identity/store";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });

const plugin = (scopes?: string[]) => ({ id: "demo", manifest: manifestSchema.parse({
  id: "demo", version: "1.0.0", publisher: "test", host: ">=1.4.0",
  capabilities: [{ name: "identity.sign", ...(scopes ? { scopes } : {}) }],
}) });
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

test("protocol version is 1.4.0", () => expect(PLUGIN_PROTOCOL_VERSION).toBe("1.4.0"));

test("signs only declared purposes and the signature verifies under the domain format", async () => {
  const ctx = fakeCtx();
  const r: any = await answerCapability(ctx, plugin(["greeting"]), "capability.identity.sign", { purpose: "greeting", payload: b64("hello") });
  expect(verifyFrom(r.machineId, "demo", "greeting", Buffer.from("hello"), Buffer.from(r.signature, "base64"))).toBe(true);
  expect(verifyFrom(r.machineId, "other", "greeting", Buffer.from("hello"), Buffer.from(r.signature, "base64"))).toBe(false);
  await expect(answerCapability(ctx, plugin(["greeting"]), "capability.identity.sign", { purpose: "other", payload: b64("hello") }))
    .rejects.toMatchObject({ code: "capability_denied" });
  await expect(answerCapability(ctx, plugin(), "capability.identity.sign", { purpose: "greeting", payload: b64("hello") }))
    .rejects.toMatchObject({ code: "capability_denied" });
});

test("each signature is audited in the plugin log by purpose and payload hash, not payload", async () => {
  const ctx = fakeCtx();
  await answerCapability(ctx, plugin(["greeting"]), "capability.identity.sign", { purpose: "greeting", payload: b64("secret-payload") });
  const log = readFileSync(pluginLogPath(ctx, "demo"), "utf8");
  expect(log).toMatch(/identity\.sign purpose=greeting sha256=[0-9a-f]{64}/);
  expect(log).not.toContain("secret-payload");
});

test("the transport-key purpose records the plugin's current transport key", async () => {
  const ctx = fakeCtx();
  const tk = new Uint8Array(32).fill(7);
  await answerCapability(ctx, plugin(["transport-key"]), "capability.identity.sign", { purpose: "transport-key", payload: b64(transportKeyPayload(tk)) });
  expect(currentTransportKey(ctx, "demo")).not.toBeNull();
  await expect(answerCapability(ctx, plugin(["transport-key"]), "capability.identity.sign", { purpose: "transport-key", payload: b64("short") }))
    .rejects.toMatchObject({ code: "invalid_input" });
});

test("a manifest declaring identity.sign needs host >= 1.4.0", () => {
  for (const host of ["^1", ">=1.3.0", "*"]) {
    expect(() => manifestSchema.parse({ id: "demo", version: "1.0.0", publisher: "t", host, capabilities: [{ name: "identity.sign", scopes: ["x1"] }] })).toThrow();
  }
  expect(() => manifestSchema.parse({ id: "demo", version: "1.0.0", publisher: "t", host: "^1.4.0", capabilities: [{ name: "identity.sign", scopes: ["x1"] }] })).not.toThrow();
});

test("plugin id pacer is reserved", () => {
  expect(() => manifestSchema.parse({ id: "pacer", version: "1.0.0", publisher: "t", host: "^1" })).toThrow(/reserved/);
});
