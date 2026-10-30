import { beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fakeCtx } from "./helpers";
import { answerCapability, pluginLogPath } from "../src/plugins/host";
import { manifestSchema, PLUGIN_PROTOCOL_VERSION } from "../src/plugins/protocol";
import { currentTransportKey, transportKeyPayload, verifyFrom } from "../src/identity/sign";
import { clearIdentityCache, setIdentityPlatformForTests } from "../src/identity/store";
import { identityAuditPath } from "../src/identity/audit";
import { rotateIdentity } from "../src/identity/rotate";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });

const plugin = (scopes?: string[]) => ({ id: "demo", manifest: manifestSchema.parse({
  id: "demo", version: "1.0.0", publisher: "test", host: ">=1.4.0",
  capabilities: [{ name: "identity.sign", ...(scopes ? { scopes } : {}) }],
}) });
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

test("identity.sign arrived in 1.4.0; later minors keep it", () => expect(PLUGIN_PROTOCOL_VERSION).toBe("1.5.0"));

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

const audit = (ctx: { pacerHome: string }) => readFileSync(identityAuditPath(ctx), "utf8").trim().split("\n").map(l => JSON.parse(l));

test("signatures and refusals are audited in a host-owned log by purpose and payload hash, not payload", async () => {
  const ctx = fakeCtx();
  await answerCapability(ctx, plugin(["greeting"]), "capability.identity.sign", { purpose: "greeting", payload: b64("secret-payload") });
  await expect(answerCapability(ctx, plugin(["greeting"]), "capability.identity.sign", { purpose: "other", payload: b64("x") })).rejects.toThrow();
  const sha = createHash("sha256").update("secret-payload").digest("hex");
  const entries = audit(ctx);
  expect(entries).toEqual([
    { at: ctx.now, pluginId: "demo", purpose: "greeting", sha256: sha, outcome: "signed", machineId: expect.stringMatching(/^[a-z2-7]{52}$/) },
    { at: ctx.now, pluginId: "demo", purpose: "other", sha256: createHash("sha256").update("x").digest("hex"), outcome: "refused", reason: "purpose not declared" },
  ]);
  expect(readFileSync(identityAuditPath(ctx), "utf8")).not.toContain("secret-payload");
  expect(statSync(identityAuditPath(ctx)).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(identityAuditPath(ctx))).mode & 0o777).toBe(0o700);
  expect(existsSync(pluginLogPath(ctx, "demo")) ? readFileSync(pluginLogPath(ctx, "demo"), "utf8") : "").not.toContain("identity.sign");
});

test("a plugin cannot write to or evict the audit log through capability.log", async () => {
  const ctx = fakeCtx();
  const p = { id: "demo", manifest: manifestSchema.parse({ id: "demo", version: "1.0.0", publisher: "t", host: ">=1.4.0", capabilities: [{ name: "identity.sign", scopes: ["greeting"] }, { name: "log" }] }) };
  await answerCapability(ctx, p, "capability.identity.sign", { purpose: "greeting", payload: b64("hello") });
  for (let i = 0; i < 3; i++) await answerCapability(ctx, p, "capability.log", { level: "info", message: `identity.sign purpose=greeting ${"x".repeat(4000)}` });
  expect(audit(ctx)).toHaveLength(1);
});

test("the host's rotate signature is audited", async () => {
  const ctx = fakeCtx();
  const r = await rotateIdentity(ctx);
  const sha = createHash("sha256").update(`${r.oldId}\0${r.newId}`).digest("hex");
  expect(audit(ctx)).toContainEqual({ at: ctx.now, pluginId: "pacer", purpose: "rotate", sha256: sha, outcome: "signed", machineId: r.oldId });
});

test("identity.sign is refused while the home looks copied, until rotation", async () => {
  const a = fakeCtx();
  await answerCapability(a, plugin(["greeting"]), "capability.identity.sign", { purpose: "greeting", payload: b64("hello") });
  clearIdentityCache();
  const copy = fakeCtx();
  cpSync(a.pacerHome, copy.pacerHome, { recursive: true });
  await expect(answerCapability(copy, plugin(["greeting"]), "capability.identity.sign", { purpose: "greeting", payload: b64("hello") }))
    .rejects.toMatchObject({ code: "capability_denied", message: expect.stringContaining("pacer machine rotate") });
  expect(audit(copy).at(-1)).toMatchObject({ pluginId: "demo", outcome: "refused", reason: "home looks copied" });
  await rotateIdentity(copy);
  const r: any = await answerCapability(copy, plugin(["greeting"]), "capability.identity.sign", { purpose: "greeting", payload: b64("hello") });
  expect(verifyFrom(r.machineId, "demo", "greeting", Buffer.from("hello"), Buffer.from(r.signature, "base64"))).toBe(true);
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
