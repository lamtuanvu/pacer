import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import { execProcess } from "../src/exec/process";
import { createTask, updateTask } from "../src/tasks/store";
import { checkWorkflowShape } from "../src/workflow/schema";
import { validateWorkflow } from "../src/workflow/validate";
import { canAutoDecide } from "../src/workflow/auto";
import {
  getRun, insertRun, insertStep, recordDecision, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch, integrationWorktree } from "../src/workflow/branch";
import { publishChildEnv, publishRun } from "../src/workflow/publish";
import { storeArtifact, runArtifactsDir } from "../src/workflow/artifacts";

async function repoWithBareOrigin() {
  const repo = gitRepo();
  const bare = join(tmpDir(), "origin.git");
  const ctx = fakeCtx({ run: realRun });
  expect((await ctx.run(["git", "clone", "--bare", "-q", repo, bare], 30_000)).code).toBe(0);
  expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", bare], 10_000)).code).toBe(0);
  return { ctx, repo, bare };
}

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
fs.appendFileSync(log, JSON.stringify({ argv, stdin, env: process.env }) + "\\n");
const joined = argv.join(" ");
if (joined.includes("pr list")) { process.stdout.write("[]\\n"); process.exit(0); }
if (joined.includes("pr create")) { process.stdout.write("https://example.test/pr/1\\n"); process.exit(0); }
process.exit(1);
`);
  chmodSync(script, 0o755);
  return { bin, log };
}

function withGhPath(ctx: ReturnType<typeof fakeCtx>, bin: string) {
  const path = `${bin}:${ctx.env.PATH ?? process.env.PATH ?? "/usr/bin"}`;
  ctx.env = { ...ctx.env, PATH: path };
  // When callers pass an explicit env (publishChildEnv), use it as the full child
  // env — do not re-merge process.env (T3).
  const baseRun = ctx.run;
  ctx.run = (argv, timeoutMs, o) => {
    if (o?.env) {
      return execProcess({
        argv,
        cwd: o.cwd ?? process.cwd(),
        env: { ...o.env, PATH: o.env.PATH ?? path },
        timeoutMs,
        stdin: o.stdin,
      });
    }
    return baseRun(argv, timeoutMs, o);
  };
  ctx.which = (name: string) => (name === "gh" ? join(bin, "gh") : "/usr/bin/fake");
}

test("I7: approval for a different tip SHA is refused; person tip match allows publish", async () => {
  const { ctx, repo } = await repoWithBareOrigin();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const wt = await integrationWorktree(ctx, getRun(ctx, run.id)!);
  await Bun.write(join(wt, "feat.txt"), "feat");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat"], 10_000);
  const tip = (await ctx.run(["git", "-C", repo, "rev-parse", getRun(ctx, run.id)!.branch!], 10_000)).stdout.trim().toLowerCase();

  const { bin } = installGhStub(ctx.home);
  withGhPath(ctx, bin);

  recordDecision(ctx, {
    runId: run.id, stepId: "ask", attempt: 1, actor: "person",
    kind: "publish_approved", choice: "approve",
    reason: `approves: publish tip=${"a".repeat(40)}`,
  });
  await expect(publishRun(ctx, run.id, {
    draft: false, title: "t", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({ code: "not_allowed" });

  recordDecision(ctx, {
    runId: run.id, stepId: "ask", attempt: 1, actor: "person",
    kind: "publish_approved", choice: "approve",
    reason: `approves: publish tip=${tip}`,
  });
  const ok = await publishRun(ctx, run.id, {
    draft: false, title: "t", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  });
  expect(ok.pr_url).toBe("https://example.test/pr/1");
});

test("I8: detached HEAD base is refused", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  const tip = (await ctx.run(["git", "-C", repo, "rev-parse", "HEAD"], 10_000)).stdout.trim();
  expect((await ctx.run(["git", "-C", repo, "checkout", "--detach", tip], 10_000)).code).toBe(0);
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await expect(ensureRunBranch(ctx, run)).rejects.toMatchObject({
    code: "invalid_input",
    message: expect.stringMatching(/detached HEAD/i),
  } as Partial<CoreError>);
});

test("I9: step id charset and flat artifact blobs", async () => {
  const shape = checkWorkflowShape({
    id: "t/bad",
    version: 1,
    entry: "../../x",
    steps: {
      "../../x": { type: "agent", kind: "research", prompt: "no" },
      done: { type: "end" },
    },
    edges: [{ from: "../../x", to: "done" }],
  });
  expect(shape.errors).toEqual([]);
  const errs = validateWorkflow(shape.def!);
  expect(errs.some(e => /must match/.test(e.message))).toBe(true);

  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  const task = createTask(ctx, {
    brief: { goal: "a", repo }, kind: "feature", requestedExecutor: null, timeoutS: 60,
  });
  insertStep(ctx, { runId: run.id, stepId: "impl", attempt: 1, taskId: task.id, status: "running" });
  const wt = tmpDir();
  await Bun.write(join(wt, "shot.png"), "png");
  updateTask(ctx, task.id, t => { t.worktree = wt; t.state = "running"; });
  const art = storeArtifact(ctx, task.id, { path: join(wt, "shot.png"), label: "shot" });
  expect(art.absPath).toBe(join(runArtifactsDir(ctx, run.id), art.id));
  expect(art.absPath.includes(`${sep}impl${sep}`)).toBe(false);
});

test("I10: publish child env strips PACER_RUN_GRANT", () => {
  const ctx = fakeCtx({
    env: {
      PACER_RUN_GRANT: "prg_secret",
      PACER_ROLE: "orchestrator",
      HOME: "/tmp",
      PATH: "/usr/bin",
      GIT_AUTHOR_NAME: "t",
      GIT_DIR: "/leak",
      GH_HOST: "github.example",
    },
  });
  const env = publishChildEnv(ctx);
  expect(env.PACER_RUN_GRANT).toBeUndefined();
  expect(env.PACER_ROLE).toBeUndefined();
  expect(env.HOME).toBe("/tmp");
  expect(env.GIT_AUTHOR_NAME).toBe("t");
  expect(env.GIT_DIR).toBeUndefined();
  expect(env.GH_HOST).toBe("github.example");
  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
});

test("T3: wire-level gh and pre-push see no PACER_* and use explicit refspec", async () => {
  const { ctx, repo } = await repoWithBareOrigin();
  workflowDatabase(ctx);
  ctx.env = {
    ...ctx.env,
    PACER_RUN_GRANT: "prg_secret_token",
    PACER_ROLE: "orchestrator",
    HOME: ctx.home,
  };
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const wt = await integrationWorktree(ctx, getRun(ctx, run.id)!);
  await Bun.write(join(wt, "feat.txt"), "feat");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat"], 10_000);
  const tip = (await ctx.run(["git", "-C", repo, "rev-parse", getRun(ctx, run.id)!.branch!], 10_000)).stdout.trim().toLowerCase();

  const hookDir = join(repo, ".git", "hooks");
  mkdirSync(hookDir, { recursive: true });
  const hookEnv = join(ctx.home, "pre-push-env.json");
  writeFileSync(join(hookDir, "pre-push"), `#!/usr/bin/env bun
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(hookEnv)}, JSON.stringify(process.env));
process.exit(0);
`);
  chmodSync(join(hookDir, "pre-push"), 0o755);

  const { bin, log } = installGhStub(ctx.home);
  withGhPath(ctx, bin);
  recordDecision(ctx, {
    runId: run.id, stepId: "ask", attempt: 1, actor: "person",
    kind: "publish_approved", choice: "approve",
    reason: `approves: publish tip=${tip}`,
  });
  const ok = await publishRun(ctx, run.id, {
    draft: false, title: "t", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  });
  expect(ok.pr_url).toBe("https://example.test/pr/1");

  const ghLines = (await Bun.file(log).text()).trim().split("\n").map(l => JSON.parse(l) as { argv: string[]; env: Record<string, string> });
  expect(ghLines.length).toBeGreaterThan(0);
  for (const line of ghLines) {
    expect(line.env.PACER_RUN_GRANT).toBeUndefined();
    expect(line.env.PACER_ROLE).toBeUndefined();
    expect(line.env.HOME).toBeTruthy();
    expect(line.env.PATH).toBeTruthy();
  }
  const create = ghLines.find(l => l.argv.includes("create"));
  expect(create).toBeTruthy();
  expect(ctx.which("gh")).toBe(join(bin, "gh"));

  const hook = JSON.parse(await Bun.file(hookEnv).text()) as Record<string, string>;
  expect(hook.PACER_RUN_GRANT).toBeUndefined();
  expect(hook.PACER_ROLE).toBeUndefined();
  expect(hook.HOME).toBeTruthy();

  // Explicit refspec was used for the push (not a bare branch name).
  const branch = getRun(ctx, run.id)!.branch!;
  const show = await ctx.run(["git", "-C", repo, "ls-remote", "origin", `refs/heads/${branch}`], 10_000);
  expect(show.stdout).toContain(branch);
});

test("canAutoDecide refuses approves: publish", () => {
  expect(canAutoDecide(
    { id: "run_x", workflow: "t", version: 1, repo: "/", brief: "b", title: "t", status: "running", rev: 1, createdAt: 0, updatedAt: 0, loops: {}, auto: true },
    "ask",
    { type: "human", decision: "auto", approves: "publish", question: { kind: "approve_revise", text: "P?" } },
  )).toBe(false);
});
