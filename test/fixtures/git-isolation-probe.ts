import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveRepo } from "../../src/core/repos";
import { fakeCtx, gitRepo, realRun, tmpDir } from "../helpers";

// Launched explicitly by setup-git-isolation.test.ts in a fresh test process.
test("helper and raw temp folders do not inherit an enclosing checkout", async () => {
  for (const folder of [tmpDir(), mkdtempSync(join(tmpdir(), "raw-"))]) {
    const result = await realRun(["git", "-C", folder, "rev-parse", "--show-toplevel"], 2000);
    expect(result.code).not.toBe(0);
    const ctx = fakeCtx({ run: realRun });
    expect(await resolveRepo(ctx, folder)).toMatchObject({ identityUnverified: true });
    expect(await Bun.file(join(ctx.pacerHome, "state", "repos.json")).exists()).toBe(false);
  }
});

test("Git still discovers fixture repositories from subfolders and the enclosing checkout explicitly", async () => {
  const repo = gitRepo(), subfolder = join(repo, "src", "nested");
  mkdirSync(subfolder, { recursive: true });
  const ctx = fakeCtx({ run: realRun });
  expect(await resolveRepo(ctx, subfolder)).toEqual(await resolveRepo(ctx, repo));
  const enclosing = process.env.PACER_TEST_ENCLOSING_CHECKOUT!;
  const result = await realRun(["git", "-C", enclosing, "rev-parse", "--show-toplevel"], 2000);
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe(realpathSync(enclosing));
  const blocked = await realRun(["git", "-C", join(enclosing, "existing-ceiling", "child"), "rev-parse", "--show-toplevel"], 2000);
  if (process.env.PACER_TEST_CEILING_BLOCKED === "true") expect(blocked.code).not.toBe(0);
  else {
    expect(blocked.code).toBe(0);
    expect(blocked.stdout.trim()).toBe(realpathSync(enclosing));
  }
  // Exact text matters: removing an empty marker changes symlink resolution.
  expect(process.env.GIT_CEILING_DIRECTORIES!.startsWith(
    process.env.PACER_TEST_INHERITED_CEILING! + delimiter,
  )).toBe(true);
});
