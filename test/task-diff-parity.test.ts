import { diff } from "../src/core/tasks";
import type { DiffFile } from "../src/tasks/diff";
import type { WorktreeRequest } from "../src/tasks/types";
import { beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import fixtureCases from "./fixtures/task-diff/file-tree-parity.json";

const ROOT = join(import.meta.dir, "..");
const TARGET = join(ROOT, "target");
let probe = "";

type FixtureCase = {
  name: string;
  summaryOnly?: boolean;
  startCommit?: boolean;
  orca?: Extract<WorktreeRequest, "current" | "new">;
  files: DiffFile[];
};

const cases = fixtureCases.cases as FixtureCase[];

beforeAll(() => {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-lifecycle", "--bin", "task_diff_probe"], {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
  });
  probe = join(TARGET, "debug", "task_diff_probe");
});

function rustDiff(pacerHome: string, taskId: string, path?: string, summaryOnly = false) {
  const args = [pacerHome, taskId, ...(path ? [path] : [])];
  const out = execFileSync(probe, args, {
    encoding: "utf8",
    env: { ...process.env, ...(summaryOnly ? { SUMMARY_ONLY: "1" } : {}) },
  });
  return JSON.parse(out) as {
    base: string | null;
    worktree: string;
    files: DiffFile[];
    patch: string;
    untracked: string[];
    truncated: boolean;
    note?: string;
  };
}

function defaultFixture() {
  const repo = gitRepo(), ctx = fakeCtx({ run: realRun });
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", repo, ...args]);
    expect(r.exitCode).toBe(0);
  };
  writeFileSync(`${repo}/modified.txt`, "one\n");
  writeFileSync(`${repo}/old.txt`, "rename content\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial files");
  writeFileSync(`${repo}/modified.txt`, "two\n");
  writeFileSync(`${repo}/added.txt`, "added\n");
  git("mv", "old.txt", "renamed.txt");
  git("add", ".");
  const task = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  return { repo, ctx, task, git };
}

for (const spec of cases) {
  test(`task_diff file tree parity: ${spec.name}`, async () => {
    const { repo, ctx, task, git } = defaultFixture();
    if (spec.startCommit) {
      const start = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "task work");
      updateTask(ctx, task.id, (t) => {
        t.startSha = start;
        t.run = { workdir: repo, dir: repo, attempt: 1, executor: "cursor", startedAt: 1, mode: "current", logFile: "" };
      });
    }
    if (spec.orca) {
      const orca = spec.orca;
      git("checkout", "-qb", "feature");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "earlier branch work");
      const start = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
      writeFileSync(join(repo, "task-only.txt"), "task work\n");
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "task work");
      updateTask(ctx, task.id, (t) => {
        t.backend = "orca";
        t.placement = { requested: orca, mode: orca, why: "test" };
        t.baseBranch = "main";
        if (orca === "current") t.startSha = start;
        else t.baseSha = start;
      });
    }
    const ts = spec.summaryOnly ? { summaryOnly: true as const } : {};
    const tsResult = await diff(ctx, task.id, ts);
    const rust = rustDiff(ctx.pacerHome, task.id, undefined, spec.summaryOnly);
    expect(tsResult.files).toEqual(spec.files);
    expect(rust.files).toEqual(spec.files);
    expect(rust.files).toEqual(tsResult.files);
    if (spec.summaryOnly) {
      expect(rust.patch).toBe("");
      expect(tsResult.patch).toBe("");
    } else {
      expect(rust.patch).toBe(tsResult.patch);
    }
    expect(rust.worktree).toBe(tsResult.worktree);
    expect(rust.base).toBe(tsResult.base);
  });
}
