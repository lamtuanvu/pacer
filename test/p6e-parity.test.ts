import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { reference } from "./fixtures/p6e/reference";
import { p6eCases } from "./fixtures/p6e/cases";

const root = join(import.meta.dir, "..");
const example = join(root, "target", "debug", "examples", "decisions");

beforeAll(() => {
  const build = spawnSync(
    "cargo",
    ["build", "--locked", "--quiet", "-p", "pacer-lifecycle", "--example", "decisions"],
    { cwd: root, encoding: "utf8", timeout: 180_000 },
  );
  if (build.error || build.status !== 0)
    throw new Error(`P6e Rust example build failed: ${build.error?.message ?? build.stderr}`);
}, 210_000);

// The example is a test adapter, never a native operation or runtime caller.
test("P6e Rust decisions match current TypeScript goldens", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL("./fixtures/p6e/goldens.json", import.meta.url),
      "utf8",
    ),
  );
  const result = Bun.spawnSync(
    [example],
    {
      cwd: root,
      stdin: Buffer.from(
        cases.map((c: any) => JSON.stringify(c.input)).join("\n") + "\n",
      ),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const lines = result.stdout.toString().trim().split("\n");
  expect(lines).toHaveLength(cases.length);
  for (let i = 0; i < cases.length; i++)
    expect(
      JSON.parse(lines[i]!),
      `case ${i}: ${JSON.stringify(cases[i].input)}`,
    ).toEqual(cases[i].expected);
}, 30_000);

// A changed TS branch must force regeneration instead of silently preserving an
// obsolete port target. Programming errors in the loader are rethrown.
test("P6e goldens remain fresh against their current TS sources", async () => {
  const goldens = JSON.parse(
    readFileSync(
      new URL("./fixtures/p6e/goldens.json", import.meta.url),
      "utf8",
    ),
  );
  const cases = JSON.parse(JSON.stringify(p6eCases()));
  expect(goldens.map((g: any) => g.input)).toEqual(cases);
  for (let i = 0; i < goldens.length; i++)
    expect(
      JSON.parse(JSON.stringify(await reference(structuredClone(cases[i])))),
      `reference case ${i}`,
    ).toEqual(goldens[i].expected);
});
