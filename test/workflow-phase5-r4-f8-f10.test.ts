import { expect, test } from "bun:test";
import { closeSync, existsSync, openSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { writeLockToken } from "../src/core/lock";
import { cleanOrphanTmp } from "../src/workflow/artifacts";

test("F8: writeLockToken unlinks the empty lock when the token write fails", () => {
  const file = join(tmpDir(), "nospace.lock");
  closeSync(openSync(file, "wx"));
  expect(existsSync(file)).toBe(true);
  const err = new Error("ENOSPC") as NodeJS.ErrnoException;
  err.code = "ENOSPC";
  expect(() => writeLockToken(file, "a".repeat(32), () => { throw err; })).toThrow(/ENOSPC/);
  expect(existsSync(file)).toBe(false);
});

test("F8: cleanOrphanTmp keeps a fresh live-pid temp and removes old or dead-pid temps", () => {
  const root = tmpDir();
  const live = join(root, `art_live.tmp-${process.pid}-aabb`);
  const dead = join(root, `art_dead.tmp-99999999-ccdd`);
  const old = join(root, `art_old.tmp-${process.pid}-eeff`);
  writeFileSync(live, "x");
  writeFileSync(dead, "y");
  writeFileSync(old, "z");
  const past = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(old, past, past);

  cleanOrphanTmp(root);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(old)).toBe(false);
});

test("F9: syncBase GIT_ASKPASS is PATH-resolved 'true'", () => {
  const src = readFileSync(join(import.meta.dir, "../src/workflow/branch.ts"), "utf8");
  expect(src).toMatch(/GIT_ASKPASS:\s*"true"/);
  expect(src).not.toMatch(/GIT_ASKPASS:\s*"\/usr\/bin\/true"/);
});
