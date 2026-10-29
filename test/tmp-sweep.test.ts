import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { markTestTmp, sweepTestTmp } from "./tmp-sweep";

test("temp sweep removes dead owners and old unmarked dirs, preserves live, young and kept dirs", () => {
  const dirs: string[] = [];
  const make = () => { const dir = mkdtempSync(join(tmpdir(), "pacer-test-sweep-")); dirs.push(dir); return dir; };
  const keep = process.env.PACER_KEEP_TEST_TMP, originalTmp = process.env.TMPDIR;
  const root = tmpDir();
  process.env.TMPDIR = root;
  try {
    delete process.env.PACER_KEEP_TEST_TMP;
    const dead = make(), live = make(), young = make(), old = make(), target = make();
    const child = Bun.spawnSync([process.execPath, "-e", "process.exit(0)"]);
    writeFileSync(join(dead, ".pacer-test-owner.json"), JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
    markTestTmp(live);
    const reused = make();
    writeFileSync(join(reused, ".pacer-test-owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 25 * 60 * 60 * 1000 }));
    const past = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(old, past, past);
    const malformed = make();
    writeFileSync(join(malformed, ".pacer-test-owner.json"), "{");
    utimesSync(malformed, past, past);
    const link = target + "-link";
    symlinkSync(target, link); dirs.push(link);
    process.env.PACER_KEEP_TEST_TMP = "1";
    sweepTestTmp();
    expect(existsSync(dead)).toBe(true);
    expect(existsSync(old)).toBe(true);
    delete process.env.PACER_KEEP_TEST_TMP;
    sweepTestTmp();
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(reused)).toBe(false);
    expect(existsSync(malformed)).toBe(false);
    for (const dir of [live, young, target, link]) expect(existsSync(dir)).toBe(true);
  } finally {
    if (keep === undefined) delete process.env.PACER_KEEP_TEST_TMP;
    else process.env.PACER_KEEP_TEST_TMP = keep;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
  }
});
