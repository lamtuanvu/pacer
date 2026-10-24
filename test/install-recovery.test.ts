import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { recoverInstall } from "../src/install/journal";
import { writeInstallFile } from "../src/install/atomic";

test("interrupted integration writes roll back before retry without overwriting external edits", () => {
  const ctx = fakeCtx(), path = join(ctx.home, "managed");
  const journal = join(ctx.pacerHome, "install-transaction.json");
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(path, "partial");
  writeFileSync(journal, JSON.stringify({ schema: 1, files: [{ path, before: "old", after: "partial" }], manifestHash: "not committed" }));
  recoverInstall(ctx);
  expect(readFileSync(path, "utf8")).toBe("old");
  expect(existsSync(journal)).toBe(false);
  writeFileSync(path, "user");
  writeFileSync(journal, JSON.stringify({ schema: 1, files: [{ path, before: "old", after: "partial" }], manifestHash: "not committed" }));
  expect(() => recoverInstall(ctx)).toThrow("changed during recovery");
  expect(readFileSync(path, "utf8")).toBe("user");
  expect(existsSync(journal)).toBe(true);
});

test("atomic installation refuses symlink destinations including parent folders", () => {
  const ctx = fakeCtx(), target = join(ctx.home, "target"), link = join(ctx.home, "link");
  writeFileSync(target, "mine"); symlinkSync(target, link);
  expect(() => writeInstallFile(link, "overwrite")).toThrow();
  expect(readFileSync(target, "utf8")).toBe("mine");
  mkdirSync(ctx.pacerHome, { recursive: true });
  const dirLink = join(ctx.home, "dir-link"); symlinkSync(ctx.pacerHome, dirLink);
  expect(() => writeInstallFile(join(dirLink, "unexpected"), "overwrite")).toThrow();
  expect(existsSync(join(ctx.pacerHome, "unexpected"))).toBe(false);
});

test("atomic refresh preserves executable owner permission for a status-line script", () => {
  const ctx = fakeCtx(), path = join(ctx.home, "status.sh");
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeInstallFile(path, "#!/bin/sh\nexit 1\n");
  expect(Bun.spawnSync([path]).exitCode).toBe(1);
});

test("recovery preserves executable permission when restoring a moved legacy script", () => {
  const ctx = fakeCtx(), path = join(ctx.home, "legacy.sh"); mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "install-transaction.json"), JSON.stringify({ schema: 1, files: [{ path, before: "#!/bin/sh\nexit 1\n", after: null, beforeMode: 0o700 }], manifestHash: "not committed" }));
  recoverInstall(ctx);
  expect(Bun.spawnSync([path]).exitCode).toBe(1);
});
