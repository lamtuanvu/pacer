import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { reference } from "./fixtures/p6e/reference";
import { p6eCases } from "./fixtures/p6e/cases";

// The example is a test adapter, never a native operation or runtime caller.
test("P6e Rust decisions match current TypeScript goldens", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL("./fixtures/p6e/goldens.json", import.meta.url),
      "utf8",
    ),
  );
  const result = Bun.spawnSync(
    [
      "cargo",
      "run",
      "--locked",
      "--quiet",
      "-p",
      "pacer-lifecycle",
      "--example",
      "decisions",
    ],
    {
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
});

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
