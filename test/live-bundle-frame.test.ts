import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exerciseBundleFrameHome } from "../scripts/live/bundle-frame";
import { main } from "../scripts/live/cli";
import { tmpDir } from "./helpers";

test("fixed bundle framing harness records actual stage results and cleanup in a private child", async () => {
  const home = join(realpathSync(tmpDir()), "bundle-frame-fixture");
  const result = await exerciseBundleFrameHome(home);
  expect(result.cases).toHaveLength(28);
  expect(result.failed).toBe(0);
  expect(result.childProcess).toBe("simulated-no-pid");
  expect(JSON.parse(readFileSync(join(home, "result.json"), "utf8"))).toEqual(result);
  await expect(exerciseBundleFrameHome(home)).rejects.toThrow();
});

test("bundle fixture refuses a redirected parent without writing outside", async () => {
  const root = realpathSync(tmpDir()), outside = realpathSync(tmpDir());
  writeFileSync(join(outside, "sentinel"), "untouched");
  symlinkSync(outside, join(root, "home"));
  await expect(exerciseBundleFrameHome(join(root, "home", "bundle-frame-fixture"))).rejects.toThrow("canonical owned private home");
  expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("untouched");
  expect(existsSync(join(outside, "bundle-frame-fixture"))).toBe(false);
});

test("bundle fixture refuses an existing symlink child", async () => {
  const root = realpathSync(tmpDir()), outside = realpathSync(tmpDir());
  symlinkSync(outside, join(root, "bundle-frame-fixture"));
  await expect(exerciseBundleFrameHome(join(root, "bundle-frame-fixture"))).rejects.toThrow();
  expect(existsSync(join(outside, ".bundle-frame-fixture"))).toBe(false);
});

test("bundle-frame CLI accepts no executable, argument, path or extra option", async () => {
  for (const argv of [
    ["bundle-frame"], ["bundle-frame", "--id", "unused", "ssh"],
    ["bundle-frame", "--id", "unused", "--", "ssh"],
    ["bundle-frame", "--id", "unused", "--seed", "ui"],
    ["bundle-frame", "--id", "unused", "--keep"],
  ]) await expect(main(argv)).rejects.toThrow(/usage: live bundle-frame|--seed is only valid for up/);
});
