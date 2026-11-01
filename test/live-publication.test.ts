import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exercisePublicationHome } from "../scripts/live/publication";
import { tmpDir } from "./helpers";

test("fixed live publication fixture exercises all three Unicode boundaries in a private home", async () => {
  const home = join(realpathSync(tmpDir()), "publication-fixture");
  await exercisePublicationHome(home);
  expect(existsSync(join(home, "link/latest.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(home, "sequence-fixture/link/latest.json"), "utf8")).seq).toBe(1);
  expect(readFileSync(join(home, `state/activity.jsonl.${process.pid}.tmp`), "utf8")).toBe("stale");
  expect(readFileSync(join(home, "endpoints/state.json"), "utf8")).toContain("not_working");
  await expect(exercisePublicationHome(home)).rejects.toThrow();
});

test("publication fixture refuses a redirected parent without writing outside", async () => {
  const root = realpathSync(tmpDir());
  const outside = realpathSync(tmpDir());
  writeFileSync(join(outside, "sentinel"), "untouched");
  symlinkSync(outside, join(root, "home"));
  await expect(exercisePublicationHome(join(root, "home", "publication-fixture"))).rejects.toThrow("canonical owned private home");
  expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("untouched");
  expect(existsSync(join(outside, "publication-fixture"))).toBe(false);
});

test("publication fixture refuses a preexisting fixture child", async () => {
  const root = realpathSync(tmpDir());
  const outside = realpathSync(tmpDir());
  symlinkSync(outside, join(root, "publication-fixture"));
  await expect(exercisePublicationHome(join(root, "publication-fixture"))).rejects.toThrow();
  expect(existsSync(join(outside, "strategy.yaml"))).toBe(false);
});
