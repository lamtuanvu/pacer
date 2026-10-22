import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultUpdateDeps, runUpdate } from "../src/update/update";
import { fakeCtx, tmpDir } from "./helpers";

test("updates target the explicit Rust front door rather than its running Bun core", () => {
  expect(defaultUpdateDeps(fakeCtx({ env: { PACER_BIN: "/opt/pacer" } })).execPath).toBe("/opt/pacer");
  expect(defaultUpdateDeps(fakeCtx({ env: {} })).execPath).toBe(process.execPath);
});

test("a paired app front door keeps the complete-app updater refusal", async () => {
  const front = join(tmpDir(), "pacer.app/Contents/Resources/pacer");
  mkdirSync(join(front, ".."), { recursive: true });
  writeFileSync(front, "bundled front door", { mode: 0o755 });
  const deps = defaultUpdateDeps(fakeCtx({ env: { PACER_BIN: front } }));
  const result = await runUpdate({ check: false }, { ...deps, standalone: true, fetch: async () => { throw Error("must not fetch"); } });
  expect(result.code).toBe(2);
  expect(result.err).toContain("Settings → Updates");
});
