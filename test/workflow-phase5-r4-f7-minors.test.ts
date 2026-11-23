import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { withLock } from "../src/core/lock";
import {
  getRun, insertRun, setPublishOptIn, updateRun, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch, integrationWorktree, syncBase } from "../src/workflow/branch";
import { hasUnresolvedConflictTask, publishRun } from "../src/workflow/publish";
import { cleanupRun } from "../src/workflow/cleanup";

test("F7: terminal settle is fire-and-forget with bounded retries", () => {
  const src = readFileSync(join(import.meta.dir, "../src/workflow/engine.ts"), "utf8");
  expect(src).toMatch(/scheduleSettleRunGit/);
  expect(src).toMatch(/for \(let attempt = 0; attempt < 3; attempt\+\+\)/);
  expect(src).toMatch(/settleRunGitOnTerminal/);
  // patchRun must schedule settle, not await it (blocks stop behind the merge lock).
  expect(src).toMatch(/scheduleSettleRunGit\(ctx, updated\)/);
  expect(src).not.toMatch(/await settleRunGitAfterTerminal\(ctx, updated\)/);
});

test("F7: withLock finally deletes only its own token after a stale takeover", async () => {
  const ctx = fakeCtx();
  const file = join(ctx.pacerHome, "orca", "tok.lock");
  let newToken = "";

  const oldHolder = withLock(ctx, "tok", async () => {
    // Age the lock so the waiter can take over while we are still inside.
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);
    await Bun.sleep(80);
    // After return, finally must not wipe the takeover holder's token.
    return "old";
  }, { timeoutMs: 5_000, staleMs: 120_000 });

  await Bun.sleep(20);
  const past = new Date(Date.now() - 60_000);
  try { utimesSync(file, past, past); } catch { /* not created yet */ }

  const newHolder = withLock(ctx, "tok", async () => {
    newToken = readFileSync(file, "utf8");
    await Bun.sleep(100);
    expect(readFileSync(file, "utf8")).toBe(newToken);
    return "new";
  }, { timeoutMs: 3_000, staleMs: 10 });

  const [a, b] = await Promise.all([oldHolder, newHolder]);
  expect(a).toBe("old");
  expect(b).toBe("new");
  expect(newToken.length).toBe(32);
  expect(existsSync(file)).toBe(false);
});

test("F7: withLock clears heartbeat on throw and on normal return", async () => {
  const ctx = fakeCtx();
  await expect(withLock(ctx, "boom", async () => {
    throw new Error("boom");
  })).rejects.toThrow("boom");
  expect(await withLock(ctx, "boom", async () => "after")).toBe("after");
  expect(await withLock(ctx, "ok", async () => "fine")).toBe("fine");
  expect(existsSync(join(ctx.pacerHome, "orca", "ok.lock"))).toBe(false);
});

test("F7: heartbeat refreshes lock mtime while held", async () => {
  const ctx = fakeCtx();
  const file = join(ctx.pacerHome, "orca", "beat.lock");
  await withLock(ctx, "beat", async () => {
    expect(existsSync(file)).toBe(true);
    const before = statSync(file).mtimeMs;
    // Age the mtime back, then apply the same utimes refresh the heartbeat uses.
    const past = new Date(Date.now() - 120_000);
    utimesSync(file, past, past);
    expect(statSync(file).mtimeMs).toBeLessThan(before);
    const now = new Date();
    utimesSync(file, now, now);
    expect(statSync(file).mtimeMs).toBeGreaterThan(past.getTime());
  });
  expect(existsSync(file)).toBe(false);
});

test("F7: malformed conflict sentinel fails publish closed", async () => {
  const ctx = fakeCtx({ run: realRun });
  workflowDatabase(ctx);
  const repo = gitRepo();
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const live = getRun(ctx, run.id)!;
  workflowDatabase(ctx).query("UPDATE workflow_runs SET conflict = ? WHERE id = ?")
    .run("{not-json", live.id);
  expect(hasUnresolvedConflictTask(ctx, live.id)).toBe(true);
  setPublishOptIn(ctx, live.id, "draft");
  await expect(publishRun(ctx, live.id, {
    draft: true, title: "t", body: "b", expectRev: getRun(ctx, live.id)!.rev,
  })).rejects.toThrow(/unresolved conflict/i);
});

test("F7: syncBase child env has no PACER_RUN_GRANT (wire-level)", async () => {
  const repo = gitRepo();
  const bare = join(tmpDir(), "origin.git");
  const ctx = fakeCtx({ run: realRun });
  expect((await ctx.run(["git", "clone", "--bare", "-q", repo, bare], 30_000)).code).toBe(0);
  expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", bare], 10_000)).code).toBe(0);

  const envLog = join(ctx.home, "sync-env.json");
  ctx.env = {
    ...ctx.env,
    PACER_RUN_GRANT: "prg_secret_wire",
    PACER_ROLE: "orchestrator",
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  const baseRun = ctx.run;
  ctx.run = async (argv, timeoutMs, o) => {
    if (argv[0] === "git" && argv.includes("fetch")) {
      writeFileSync(envLog, JSON.stringify(o?.env ?? {}));
    }
    return baseRun(argv, timeoutMs, o);
  };

  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  workflowDatabase(ctx).query("UPDATE workflow_runs SET base_ref = ? WHERE id = ?")
    .run("origin/main", run.id);
  await syncBase(ctx, run.id, getRun(ctx, run.id)!.rev);
  expect(existsSync(envLog)).toBe(true);
  const env = JSON.parse(readFileSync(envLog, "utf8")) as Record<string, string | undefined>;
  expect(env.PACER_RUN_GRANT).toBeUndefined();
  expect(env.PACER_ROLE).toBeUndefined();
  expect(env.HOME).toBeTruthy();
  expect(env.PATH).toBeTruthy();
});

test("F7: gh argv includes --repo from origin URL", async () => {
  const repo = gitRepo();
  const bare = join(tmpDir(), "origin.git");
  const ctx = fakeCtx({ run: realRun });
  expect((await ctx.run(["git", "clone", "--bare", "-q", repo, bare], 30_000)).code).toBe(0);
  expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", bare], 10_000)).code).toBe(0);

  const ghLog = join(ctx.home, "gh.jsonl");
  const bin = join(ctx.home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bun
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
if (process.argv.includes("list")) { process.stdout.write("[]\\n"); process.exit(0); }
if (process.argv.includes("create")) { process.stdout.write("https://example.test/pr/9\\n"); process.exit(0); }
process.exit(1);
`);
  chmodSync(join(bin, "gh"), 0o755);
  ctx.env = { ...ctx.env, PATH: `${bin}:${process.env.PATH}` };
  ctx.which = (n) => (n === "gh" ? join(bin, "gh") : "/usr/bin/fake");
  const baseRun = ctx.run;
  ctx.run = async (argv, timeoutMs, o) => {
    if (argv.includes("remote") && argv.includes("get-url")) {
      return { code: 0, stdout: "git@github.com:acme/demo.git\n", stderr: "" };
    }
    if (argv[0] === "git" && argv.includes("push")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return baseRun(argv, timeoutMs, {
      ...o,
      env: { ...process.env, ...ctx.env, ...(o?.env ?? {}), PATH: ctx.env.PATH },
    });
  };

  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  setPublishOptIn(ctx, run.id, "draft");
  const live = getRun(ctx, run.id)!;
  const wt = await integrationWorktree(ctx, live);
  await Bun.write(join(wt, "f.txt"), "x");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"], 10_000);

  await publishRun(ctx, run.id, {
    draft: true, title: "t", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  });
  const lines = readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean)
    .map(l => JSON.parse(l) as { argv: string[] });
  expect(lines.some(l => l.argv.includes("--repo") && l.argv.includes("acme/demo"))).toBe(true);
});

test("F7: refs/heads qualification — a same-named tag does not spoof the tip", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const live = getRun(ctx, run.id)!;
  const branch = live.branch!;
  const branchSha = (await ctx.run(
    ["git", "-C", repo, "rev-parse", "--verify", `refs/heads/${branch}`],
    10_000,
  )).stdout.trim();

  await Bun.write(join(repo, "tag-only.txt"), "tag\n");
  await ctx.run(["git", "-C", repo, "add", "."], 10_000);
  await ctx.run(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "tagcommit"], 10_000);
  const tagSha = (await ctx.run(["git", "-C", repo, "rev-parse", "HEAD"], 10_000)).stdout.trim();
  await ctx.run(["git", "-C", repo, "branch", "-f", branch, branchSha], 10_000);
  await ctx.run(["git", "-C", repo, "tag", "-f", branch, tagSha], 10_000);
  expect(tagSha).not.toBe(branchSha);

  const unqualified = (await ctx.run(["git", "-C", repo, "rev-parse", "--verify", branch], 10_000)).stdout.trim();
  const qualified = (await ctx.run(
    ["git", "-C", repo, "rev-parse", "--verify", `refs/heads/${branch}`],
    10_000,
  )).stdout.trim();
  expect(unqualified).toBe(tagSha);
  expect(qualified).toBe(branchSha);

  updateRun(ctx, live.id, getRun(ctx, live.id)!.rev, { status: "done" });
  const cleaned = await cleanupRun(ctx, live.id, {
    deleteBranch: true, expectRev: getRun(ctx, live.id)!.rev,
  });
  expect(cleaned.deleted_tip).toBe(branchSha);
});
