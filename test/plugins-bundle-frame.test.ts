import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";

test("actual bundle stage retains split markers and exact binary payload through ownership transfer", async () => {
  const home = join(realpathSync(tmpDir()), "frame");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, ".bundle-frame-fixture"), "fixed bundle-stage fixture\n", { flag: "wx", mode: 0o600 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/bundle-frame.ts")], {
    env: { HOME: home, PACER_HOME: home }, stdout: "pipe", stderr: "pipe", timeout: 15000,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  const result = JSON.parse(stdout);
  expect(result.cases).toHaveLength(28);
  expect(result.cases.filter((row: { passed: boolean }) => !row.passed)).toEqual([]);
  expect(result.failed).toBe(0);
  expect(code).toBe(0);
});
