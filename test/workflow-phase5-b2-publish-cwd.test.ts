import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import {
  getRun, insertRun, recordDecision, setPublishOptIn, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch, integrationWorktree, integrationWorktreePath } from "../src/workflow/branch";
import { publishRun } from "../src/workflow/publish";
import { gitInfo } from "../src/core/git";

async function repoWithBareOrigin() {
  const repo = gitRepo();
  const bare = join(tmpDir(), "origin.git");
  const ctx = fakeCtx({ run: realRun });
  expect((await ctx.run(["git", "clone", "--bare", "-q", repo, bare], 30_000)).code).toBe(0);
  expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", bare], 10_000)).code).toBe(0);
  return { ctx, repo, bare };
}

/** Stub `gh` that records argv, stdin and process.cwd(). */
function installGhStub(home: string): { bin: string; log: string } {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(home, "gh-log.jsonl");
  const script = join(bin, "gh");
  writeFileSync(script, `#!/usr/bin/env bun
const fs = require("node:fs");
const log = ${JSON.stringify(log)};
const argv = process.argv.slice(2);
let stdin = "";
for await (const chunk of Bun.stdin.stream()) stdin += Buffer.from(chunk).toString("utf8");
fs.appendFileSync(log, JSON.stringify({ argv, stdin, cwd: process.cwd() }) + "\\n");
const joined = argv.join(" ");
if (joined.includes("pr list") || joined.includes("pr view")) {
  process.stdout.write("[]\\n");
  process.exit(0);
}
if (joined.includes("pr create")) {
  process.stdout.write("https://example.test/pr/1\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh " + joined + "\\n");
process.exit(1);
`);
  chmodSync(script, 0o755);
  return { bin, log };
}

function withGhPath(ctx: ReturnType<typeof fakeCtx>, bin: string) {
  const path = `${bin}:${ctx.env.PATH ?? process.env.PATH ?? "/usr/bin"}`;
  ctx.env = { ...ctx.env, PATH: path };
  const baseRun = ctx.run;
  ctx.run = (argv, timeoutMs, o) => baseRun(argv, timeoutMs, {
    ...o,
    env: { ...process.env, ...ctx.env, ...(o?.env ?? {}), PATH: path },
  });
  ctx.which = (name: string) => (name === "gh" ? join(bin, "gh") : "/usr/bin/fake");
}

test("gh pr list and create run with cwd set to the integration worktree", async () => {
  const { ctx, repo } = await repoWithBareOrigin();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const live = getRun(ctx, run.id)!;
  const wt = await integrationWorktree(ctx, live);
  await Bun.write(join(wt, "feat.txt"), "feat");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat"], 10_000);

  const { bin, log } = installGhStub(ctx.home);
  withGhPath(ctx, bin);
  setPublishOptIn(ctx, run.id, "draft");

  const result = await publishRun(ctx, run.id, {
    draft: true, title: "t", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  });
  expect(result.pr_url).toBe("https://example.test/pr/1");

  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);
  const expectedWt = resolve(integrationWorktreePath(ctx, info.top, run.id));

  const lines = (await Bun.file(log).text()).trim().split("\n")
    .map(l => JSON.parse(l) as { argv: string[]; cwd: string });
  expect(lines.length).toBeGreaterThanOrEqual(1);
  for (const line of lines) {
    expect(resolve(line.cwd)).toBe(expectedWt);
  }
  expect(lines.some(l => l.argv.includes("list"))).toBe(true);
  expect(lines.some(l => l.argv.includes("create"))).toBe(true);
});

test("publish rejects a recovered non-https PR URL", async () => {
  const { ctx, repo } = await repoWithBareOrigin();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const wt = await integrationWorktree(ctx, getRun(ctx, run.id)!);
  await Bun.write(join(wt, "feat.txt"), "feat");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat"], 10_000);

  const bin = join(ctx.home, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "gh");
  writeFileSync(script, `#!/bin/sh
if echo "$*" | grep -q "pr create"; then
  echo "ftp://evil.example/pr/1"
  exit 0
fi
echo "[]"
exit 0
`);
  chmodSync(script, 0o755);
  withGhPath(ctx, bin);
  setPublishOptIn(ctx, run.id, "draft");

  await expect(publishRun(ctx, run.id, {
    draft: true, title: "t", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/https/i) });
});
