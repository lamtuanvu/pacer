import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { gitRepo } from "./helpers";

test("test temp roots inside a checkout cannot discover its Git repository", () => {
  const checkout = gitRepo();
  const temp = join(checkout, ".work", "tmp");
  mkdirSync(temp, { recursive: true });
  writeFileSync(join(temp, "keep.txt"), "unrelated caller data");
  const alias = join(checkout, "temp-alias");
  symlinkSync(temp, alias, "dir");
  const existingCeiling = join(checkout, "existing-ceiling");
  mkdirSync(join(existingCeiling, "child"), { recursive: true });

  const colonTemp = join(checkout, ".work", "tmp:colon");
  mkdirSync(colonTemp);
  writeFileSync(join(colonTemp, "keep.txt"), "unrelated caller data");
  const ceilingAlias = join(checkout, "ceiling-alias");
  symlinkSync(existingCeiling, ceilingAlias, "dir");
  const unrelatedCeiling = join(checkout, "unrelated-ceiling");
  mkdirSync(unrelatedCeiling);
  const inheritedCases = [
    { ceiling: ceilingAlias, blocked: true },
    { ceiling: `${delimiter}${ceilingAlias}`, blocked: false },
    { ceiling: `${unrelatedCeiling}${delimiter}${delimiter}${ceilingAlias}`, blocked: false },
    { ceiling: `${existingCeiling}${delimiter}`, blocked: true },
  ];
  for (const [tempPath, inherited] of [
    ...inheritedCases.map(entry => [temp, entry] as const),
    [alias, inheritedCases[1]!] as const,
    [colonTemp, inheritedCases[1]!] as const,
  ]) {
    const result = Bun.spawnSync([
      process.execPath, "run", "test", "./test/repos.test.ts", "./test/fixtures/git-isolation-probe.ts",
    ], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        TMPDIR: tempPath, TMP: tempPath, TEMP: tempPath,
        PACER_KEEP_TEST_TMP: "",
        GIT_CEILING_DIRECTORIES: inherited.ceiling,
        PACER_TEST_INHERITED_CEILING: inherited.ceiling,
        PACER_TEST_CEILING_BLOCKED: String(inherited.blocked),
        PACER_TEST_ENCLOSING_CHECKOUT: realpathSync(checkout),
      },
      stdout: "pipe", stderr: "pipe",
      timeout: 30_000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(join(tempPath, "keep.txt"), "utf8")).toBe("unrelated caller data");
    expect(readdirSync(tempPath)).toEqual(["keep.txt"]);
  }
}, 190_000);

test("unrepresentable ceilings fail closed before crossing a repository", () => {
  const owner = gitRepo();
  const checkout = join(owner, "checkout:colon");
  mkdirSync(checkout);
  const init = Bun.spawnSync(["git", "init", checkout]);
  expect(init.exitCode).toBe(0);
  const temp = join(checkout, "tmp");
  mkdirSync(temp);
  const result = Bun.spawnSync([
    process.execPath, "run", "test", "./test/fixtures/git-isolation-probe.ts",
  ], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Cannot isolate Git discovery");
  expect(readdirSync(temp)).toEqual([]);
});
