import { beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { fakeKeychain } from "./fake-keychain";
import { outboxPath } from "../src/link/paths";
import { clearIdentityCache, ensureIdentity, readMeta, setIdentityPlatformForTests } from "../src/identity/store";
import { cloneSuspected } from "../src/identity/salt";
import { homeTag } from "../src/identity/key-store";
import { rotateIdentity } from "../src/identity/rotate";
import { auditSignature, identityAuditPath, AUDIT_MAX_BYTES } from "../src/identity/audit";
import { answerCapability } from "../src/plugins/host";
import { manifestSchema } from "../src/plugins/protocol";
import type { Ctx } from "../src/types";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("darwin"); });

const saltAccount = (ctx: Ctx) => `machine-install-salt/${homeTag(ctx)}`;
const announcements = (ctx: Ctx) => existsSync(outboxPath(ctx)) ? readFileSync(outboxPath(ctx), "utf8").split("\"rotated\"").length - 1 : 0;
const audit = (ctx: { pacerHome: string }) => readFileSync(identityAuditPath(ctx), "utf8").trim().split("\n").map(l => JSON.parse(l));

// N-A
test("a rotation whose completion fails once after the key swap retries and succeeds", async () => {
  const kc = fakeKeychain();
  const ctx = fakeCtx({ run: kc.run });
  const old = await ensureIdentity(ctx);
  let failures = 0;
  kc.fail.write = a => a === saltAccount(ctx) && failures++ < 1 ? 36 : undefined;
  const r = await rotateIdentity(ctx);
  expect(failures).toBe(2);
  expect(r.oldId).toBe(old.id);
  expect(readMeta(ctx)).toMatchObject({ publicId: r.newId, rotatedFrom: old.id });
  expect(readMeta(ctx)!.pendingRotation).toBeUndefined();
  expect(announcements(ctx)).toBe(1);
  expect(await cloneSuspected(ctx)).toBe(false);
});

test("a rotation that cannot complete after the key swap says it completes on the next load", async () => {
  const kc = fakeKeychain();
  const ctx = fakeCtx({ run: kc.run });
  const old = await ensureIdentity(ctx);
  kc.fail.write = a => a === saltAccount(ctx) ? 36 : undefined;
  const err = await rotateIdentity(ctx).catch(e => e);
  expect(err).toMatchObject({ code: "unavailable", data: { rotationPending: true, oldId: old.id } });
  expect(err.message).toMatch(/next time pacer loads/);
  expect(readMeta(ctx)!.pendingRotation?.newId).toBe(err.data.newId);
  expect(announcements(ctx)).toBe(0);
  kc.fail.write = undefined;
  clearIdentityCache();
  expect((await ensureIdentity(ctx)).id).toBe(err.data.newId);
  expect(announcements(ctx)).toBe(1);
  expect(await cloneSuspected(ctx)).toBe(false);
});

// N-E
for (const step of ["staged", "salted"] as const) {
  test(`a home copied while a rotation is pending (after ${step}) is flagged as copied, not silently completed`, async () => {
    setIdentityPlatformForTests("linux");
    const home = tmpDir();
    const ctx = fakeCtx({ home, env: { XDG_STATE_HOME: join(home, "state") } });
    await ensureIdentity(ctx);
    await expect(rotateIdentity(ctx, { afterStep: s => { if (s === step) throw new Error("crash"); } })).rejects.toThrow("crash");
    const copy = fakeCtx({ home, pacerHome: join(home, "copied"), env: ctx.env });
    cpSync(ctx.pacerHome, copy.pacerHome, { recursive: true });
    clearIdentityCache();
    await ensureIdentity(copy);
    const meta = readMeta(copy)!;
    expect(meta.pendingRotation).toBeUndefined();
    expect(meta.cloneDetected).toBe(true);
    expect(meta.lastRotation).toBeUndefined();
    expect(await cloneSuspected(copy)).toBe(true);
    expect(existsSync(join(copy.pacerHome, "identity", "machine.key.staging"))).toBe(false);
    // The source still completes its own rotation.
    const src = await ensureIdentity(ctx);
    expect(readMeta(ctx)!.publicId).toBe(src.id);
    expect(readMeta(ctx)!.cloneDetected).toBeUndefined();
    expect(await cloneSuspected(ctx)).toBe(false);
  });
}

// N-C
test("the audit log rotates at 1 MiB and keeps one previous generation", () => {
  const ctx = fakeCtx();
  mkdirSync(dirname(identityAuditPath(ctx)), { recursive: true });
  writeFileSync(identityAuditPath(ctx), "x".repeat(AUDIT_MAX_BYTES) + "\n", { mode: 0o600 });
  auditSignature(ctx, { pluginId: "demo", purpose: "greeting", outcome: "signed", machineId: "m" });
  expect(statSync(identityAuditPath(ctx) + ".1").size).toBe(AUDIT_MAX_BYTES + 1);
  expect(statSync(identityAuditPath(ctx) + ".1").mode & 0o777).toBe(0o600);
  expect(audit(ctx)).toHaveLength(1);
  writeFileSync(identityAuditPath(ctx), "y".repeat(AUDIT_MAX_BYTES) + "\n");
  auditSignature(ctx, { pluginId: "demo", purpose: "greeting", outcome: "signed", machineId: "m" });
  expect(readFileSync(identityAuditPath(ctx) + ".1", "utf8")[0]).toBe("y");
  expect(existsSync(identityAuditPath(ctx) + ".2")).toBe(false);
});

const plugin = (id: string, caps: unknown[]) => ({ id, manifest: manifestSchema.parse({ id, version: "1.0.0", publisher: "t", host: ">=1.4.0", capabilities: caps }) });
const b64 = (s: string) => Buffer.from(s).toString("base64");

test("refused identity.sign requests are audited at most 10 a minute per plugin, then one summary line", async () => {
  setIdentityPlatformForTests("linux");
  const ctx = fakeCtx();
  const noisy = plugin("noisy", [{ name: "identity.sign", scopes: ["greeting"] }]);
  const quiet = plugin("quiet", [{ name: "identity.sign", scopes: ["greeting"] }]);
  for (let i = 0; i < 25; i++) await answerCapability(ctx, noisy, "capability.identity.sign", { purpose: "other", payload: b64("x") }).catch(() => {});
  await answerCapability(ctx, quiet, "capability.identity.sign", { purpose: "other", payload: b64("x") }).catch(() => {});
  await answerCapability(ctx, noisy, "capability.identity.sign", { purpose: "greeting", payload: b64("x") });
  let lines = audit(ctx);
  expect(lines.filter(l => l.pluginId === "noisy" && l.outcome === "refused")).toHaveLength(10);
  expect(lines.filter(l => l.pluginId === "noisy" && l.outcome === "suppressed")).toEqual([
    { at: ctx.now, pluginId: "noisy", purpose: "", outcome: "suppressed", reason: "more than 10 refused requests in a minute; more refusals from this plugin are not logged until the minute ends" },
  ]);
  expect(lines.filter(l => l.pluginId === "quiet")).toHaveLength(1);
  expect(lines.filter(l => l.outcome === "signed")).toHaveLength(1);
  const later = { ...ctx, now: ctx.now + 60 };
  await answerCapability(later, noisy, "capability.identity.sign", { purpose: "other", payload: b64("x") }).catch(() => {});
  lines = audit(ctx);
  expect(lines.at(-1)).toMatchObject({ at: later.now, pluginId: "noisy", outcome: "refused", suppressed: 15 });
});

// N-D
test("identity.sign from a plugin that did not declare it is refused and audited", async () => {
  const ctx = fakeCtx();
  await expect(answerCapability(ctx, plugin("undeclared", [{ name: "log" }]), "capability.identity.sign", { purpose: "greeting", payload: b64("x") }))
    .rejects.toMatchObject({ code: "capability_denied" });
  expect(audit(ctx)).toEqual([{ at: ctx.now, pluginId: "undeclared", purpose: "greeting", outcome: "refused", reason: "capability not declared" }]);
});
