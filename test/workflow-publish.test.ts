import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import { createTask } from "../src/tasks/store";
import { checkWorkflowShape } from "../src/workflow/schema";
import { validateWorkflow } from "../src/workflow/validate";
import {
  getRun, insertRun, recordDecision, setPublishOptIn, setRunConflict, setRunPrUrl, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch, integrationWorktree } from "../src/workflow/branch";
import { originRepoSlug, publishRun } from "../src/workflow/publish";

/** Temp repo with a bare origin remote for real push tests. */
async function repoWithBareOrigin() {
  const repo = gitRepo();
  const bare = join(tmpDir(), "origin.git");
  const ctx = fakeCtx({ run: realRun });
  expect((await ctx.run(["git", "clone", "--bare", "-q", repo, bare], 30_000)).code).toBe(0);
  expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", bare], 10_000)).code).toBe(0);
  return { ctx, repo, bare };
}

async function seededPublishable() {
  const { ctx, repo, bare } = await repoWithBareOrigin();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const wt = await integrationWorktree(ctx, getRun(ctx, run.id)!);
  await Bun.write(join(wt, "feat.txt"), "feat");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat"], 10_000);
  return { ctx, repo, bare, run: getRun(ctx, run.id)! };
}

/** Stub `gh` that appends argv+stdin JSON lines and prints a fake PR URL. */
function installGhStub(home: string): { bin: string; log: string } {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(home, "gh-log.jsonl");
  const script = join(bin, "gh");
  // Bun is available in the test environment; use it so argv/stdin stay exact.
  writeFileSync(script, `#!/usr/bin/env bun
const fs = require("node:fs");
const log = ${JSON.stringify(log)};
const argv = process.argv.slice(2);
let stdin = "";
for await (const chunk of Bun.stdin.stream()) stdin += Buffer.from(chunk).toString("utf8");
fs.appendFileSync(log, JSON.stringify({ argv, stdin }) + "\\n");
const joined = argv.join(" ");
if (joined.includes("pr list") || joined.includes("pr view")) {
  const prior = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  if (prior.includes("pr create") || prior.includes('"create"')) {
    process.stdout.write("https://example.test/pr/1\\n");
    process.exit(0);
  }
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

async function approveFresh(ctx: ReturnType<typeof fakeCtx>, run: { id: string; repo: string; branch?: string }) {
  const tip = (await ctx.run(
    ["git", "-C", run.repo, "rev-parse", run.branch!], 10_000,
  )).stdout.trim().toLowerCase();
  recordDecision(ctx, {
    runId: run.id, stepId: "ask", attempt: 1, actor: "person",
    kind: "publish_approved", choice: "approve", reason: `approves: publish tip=${tip}`,
  });
}

test("validator refuses approves: publish on an auto step", () => {
  const shape = checkWorkflowShape({
    id: "t/pub",
    version: 1,
    entry: "ask",
    steps: {
      ask: {
        type: "human",
        decision: "auto",
        approves: "publish",
        question: { kind: "approve_revise", text: "Publish?" },
      },
      end: { type: "end" },
    },
    edges: [{ from: "ask", to: "end" }],
  });
  expect(shape.errors).toEqual([]);
  const errs = validateWorkflow(shape.def!);
  expect(errs.some(e => e.path.includes("approves") && /must/i.test(e.message))).toBe(true);
});

test("validator accepts approves: publish on a must step", () => {
  const shape = checkWorkflowShape({
    id: "t/pub",
    version: 1,
    entry: "ask",
    steps: {
      ask: {
        type: "human",
        decision: "must",
        approves: "publish",
        question: { kind: "approve_revise", text: "Publish?" },
      },
      end: { type: "end" },
    },
    edges: [{ from: "ask", to: "end" }],
  });
  expect(shape.errors).toEqual([]);
  expect(validateWorkflow(shape.def!)).toEqual([]);
  expect(shape.def!.steps.ask).toMatchObject({ approves: "publish", decision: "must" });
});

test("publish without a gate is not_allowed", async () => {
  const { ctx, run } = await seededPublishable();
  const { bin } = installGhStub(ctx.home);
  withGhPath(ctx, bin);
  await expect(publishRun(ctx, run.id, {
    draft: false, title: "t", body: "b", expectRev: run.rev,
  })).rejects.toMatchObject({ code: "not_allowed" });
});

test("stale publish approval is not_allowed", async () => {
  const { ctx, run } = await seededPublishable();
  const { bin } = installGhStub(ctx.home);
  withGhPath(ctx, bin);
  recordDecision(ctx, {
    runId: run.id, stepId: "ask", attempt: 1, actor: "person",
    kind: "publish_approved", choice: "approve", reason: "ok",
  });
  const tipCt = Number((await ctx.run(
    ["git", "-C", run.repo, "log", "-1", "--format=%ct", run.branch!], 10_000,
  )).stdout.trim());
  workflowDatabase(ctx).query(
    "UPDATE workflow_decisions SET at = ? WHERE run_id = ? AND kind = 'publish_approved'",
  ).run(tipCt - 10, run.id);

  await expect(publishRun(ctx, run.id, {
    draft: false, title: "t", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({ code: "not_allowed" });
});

test("draft opt-in allows only draft: true; title/body reach gh verbatim", async () => {
  const { ctx, run, bare } = await seededPublishable();
  const { bin, log } = installGhStub(ctx.home);
  withGhPath(ctx, bin);
  setPublishOptIn(ctx, run.id, "draft");

  await expect(publishRun(ctx, run.id, {
    draft: false, title: "t", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({ code: "not_allowed" });

  const title = 'Title with $(rm -rf ~) and "quotes"';
  const body = "body line\nsecond";
  const result = await publishRun(ctx, run.id, {
    draft: true, title, body, expectRev: getRun(ctx, run.id)!.rev,
  });
  expect(result.pr_url).toBe("https://example.test/pr/1");
  expect(getRun(ctx, run.id)!.prUrl).toBe("https://example.test/pr/1");

  const recorded = await Bun.file(log).text();
  const lines = recorded.trim().split("\n").map(l => JSON.parse(l) as { argv: string[]; stdin: string });
  const create = lines.find(l => l.argv.includes("create"));
  expect(create).toBeTruthy();
  expect(create!.argv.some(a => a === title || a === `--title=${title}`)).toBe(true);
  expect(create!.argv).toContain("--draft");
  expect(create!.stdin).toBe(body);

  const pushed = await ctx.run(["git", "--git-dir", bare, "rev-parse", run.branch!], 10_000);
  expect(pushed.code).toBe(0);
});

test("fresh publish approval pushes and opens a PR; re-publish is idempotent", async () => {
  const { ctx, run, bare } = await seededPublishable();
  const { bin, log } = installGhStub(ctx.home);
  withGhPath(ctx, bin);
  await approveFresh(ctx, run);

  const title = `Ship $(rm -rf ~) and 'quotes'`;
  const body = "PR body with `backticks` and $(echo hi)\nline2";
  const result = await publishRun(ctx, run.id, {
    draft: false, title, body, expectRev: getRun(ctx, run.id)!.rev,
  });
  expect(result.pr_url).toBe("https://example.test/pr/1");

  const recorded = await Bun.file(log).text();
  const lines = recorded.trim().split("\n").map(l => JSON.parse(l) as { argv: string[]; stdin: string });
  const create = lines.find(l => l.argv.includes("create"));
  expect(create!.argv.some(a => a === title || a === `--title=${title}`)).toBe(true);
  expect(create!.argv).not.toContain("--draft");
  expect(create!.stdin).toBe(body);

  const pushed = await ctx.run(["git", "--git-dir", bare, "rev-parse", run.branch!], 10_000);
  expect(pushed.code).toBe(0);

  const again = await publishRun(ctx, run.id, {
    draft: false, title, body, expectRev: getRun(ctx, run.id)!.rev,
  });
  expect(again.pr_url).toBe("https://example.test/pr/1");
  const after = await Bun.file(log).text();
  const creates = after.trim().split("\n")
    .map(l => JSON.parse(l) as { argv: string[] })
    .filter(l => l.argv.includes("create"));
  expect(creates.length).toBe(1);
});

test("publish refuses when an unresolved conflict task exists", async () => {
  const { ctx, run } = await seededPublishable();
  const { bin } = installGhStub(ctx.home);
  withGhPath(ctx, bin);
  await approveFresh(ctx, run);
  const resolution = createTask(ctx, {
    brief: { goal: "resolve", repo: run.repo, base: run.branch },
    kind: "debug", requestedExecutor: null, timeoutS: 600,
    title: "Conflict · t-1",
    requestId: `wfconflict:${run.id}:t-1:1`,
  });
  setRunConflict(ctx, run.id, {
    taskId: "t-1", branch: "pacer/t-1", resolutionTaskId: resolution.id,
  });
  await expect(publishRun(ctx, run.id, {
    draft: false, title: "t", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({ code: "not_allowed" });
});

test("setRunPrUrl is idempotent for the same URL and conflicts on a different one", () => {
  const ctx = fakeCtx({ run: realRun });
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo: gitRepo(), brief: "b", stepMode: "plain" });
  setRunPrUrl(ctx, run.id, "https://example.test/pr/9");
  setRunPrUrl(ctx, run.id, "https://example.test/pr/9");
  expect(getRun(ctx, run.id)!.prUrl).toBe("https://example.test/pr/9");
  expect(() => setRunPrUrl(ctx, run.id, "https://example.test/pr/other")).toThrow(CoreError);
});

test("publish refuses a title that starts with '-' or contains NUL", async () => {
  const { ctx, run } = await seededPublishable();
  const { bin } = installGhStub(ctx.home);
  withGhPath(ctx, bin);
  await approveFresh(ctx, run);
  await expect(publishRun(ctx, run.id, {
    draft: false, title: "-sneaky", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/title/i) });
  await expect(publishRun(ctx, run.id, {
    draft: false, title: "x\u0000y", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/control/i) });
});

test("publish refuses a whitespace-only title", async () => {
  const { ctx, run } = await seededPublishable();
  const { bin } = installGhStub(ctx.home);
  withGhPath(ctx, bin);
  await approveFresh(ctx, run);
  await expect(publishRun(ctx, run.id, {
    draft: false, title: "   \t  ", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/title/i) });
});

test("originRepoSlug accepts dots in repo names (https and ssh)", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  const cases: Array<{ remote: string; want: string }> = [
    { remote: "https://github.com/owner/my.repo.git", want: "owner/my.repo" },
    { remote: "https://github.com/owner/my.repo", want: "owner/my.repo" },
    { remote: "git@github.com:owner/my.repo.git", want: "owner/my.repo" },
    { remote: "ssh://git@github.com/owner/my.repo.git", want: "owner/my.repo" },
  ];
  for (const { remote, want } of cases) {
    await ctx.run(["git", "-C", repo, "remote", "remove", "origin"], 5_000);
    expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", remote], 5_000)).code).toBe(0);
    expect(await originRepoSlug(ctx, repo)).toBe(want);
  }
});
