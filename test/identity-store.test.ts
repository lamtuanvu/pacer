import { beforeEach, expect, test } from "bun:test";
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { ensureIdentity, setMachineName, sanitizeName, clearIdentityCache, setIdentityPlatformForTests } from "../src/identity/store";
import { CoreError } from "../src/core/errors";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });

test("first start creates a key, a 52-char id and a pacer-xxxx name", async () => {
  const ctx = fakeCtx();
  const id = await ensureIdentity(ctx, { platform: "linux" });
  expect(id.id).toMatch(/^[a-z2-7]{52}$/);
  expect(id.name).toMatch(/^pacer-[a-z2-7]{4}$/);
  expect(id.rev).toBe(1);
  const meta = join(ctx.pacerHome, "identity", "machine.json");
  expect(statSync(meta).mode & 0o777).toBe(0o600);
  expect(readFileSync(meta, "utf8")).not.toContain("PRIVATE");
});

test("the identity is stable across loads", async () => {
  const ctx = fakeCtx();
  const a = await ensureIdentity(ctx, { platform: "linux" });
  clearIdentityCache();
  const b = await ensureIdentity(ctx, { platform: "linux" });
  expect(b.id).toBe(a.id);
});

test("setMachineName checks expect_rev and sanitizes", async () => {
  const ctx = fakeCtx();
  await ensureIdentity(ctx, { platform: "linux" });
  const meta = await setMachineName(ctx, "  studio\u202E-mac\u0007 ", 1);
  expect(meta.name).toBe("studio-mac");
  expect(meta.rev).toBe(2);
  await expect(setMachineName(ctx, "other", 1)).rejects.toMatchObject({ code: "conflict" });
});

test("names must be 1-64 characters after sanitizing", () => {
  expect(() => sanitizeName("\u0000\u202E")).toThrow(CoreError);
  expect(sanitizeName("x".repeat(80))).toHaveLength(64);
});

test("read-only contexts cannot rename", async () => {
  const ctx = fakeCtx();
  await ensureIdentity(ctx, { platform: "linux" });
  await expect(setMachineName({ ...ctx, readOnly: true }, "x", 1)).rejects.toMatchObject({ code: "not_allowed" });
});
