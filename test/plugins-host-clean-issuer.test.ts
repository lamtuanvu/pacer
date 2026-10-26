import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueConfiguredHostClean, consumeConfiguredHostClean, validateConfiguredHostClean } from "../src/plugins/host-clean-issuer";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, realRun } from "./helpers";

test("cleanup grant pins one reviewed remote task and configured checkout", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-host-clean-"));
  const pacerHome = join(home, ".pacer"), repo = join(home, "repo");
  mkdirSync(pacerHome, { recursive: true });
  try {
    const git = async (...args: string[]) => {
      const result = await realRun(["git", ...args], 10_000);
      if (result.code) throw Error(result.stderr);
    };
    await git("init", "-q", "-b", "main", repo);
    await git("-C", repo, "remote", "add", "origin", "https://example.invalid/acme/repo.git");
    const strategy = "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n    repos: {example.invalid/acme/repo: /remote/repo}\n";
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy);
    const ctx = fakeCtx({ home, pacerHome, run: realRun });
    const task = createTask(ctx, { brief: { goal: "cleanup", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
    const worktree = join(home, ".pacer-remote", "worktrees", "repo-abc12345", `${task.id}-1`);
    const remoteDir = join(home, ".pacer-remote", "runs", task.id, "1");
    updateTask(ctx, task.id, record => { record.state = "done"; record.dismissed = true;
      record.run = { host: "box", mode: "new", remoteWorktree: worktree, remoteDir, remoteBranch: `pacer/${task.id}`,
        workdir: worktree, dir: "unused", attempt: 1, executor: "codex@box", startedAt: 1, logFile: "unused" }; });
    const grant = await issueConfiguredHostClean(ctx, "box", task.id, false);
    expect(grant.resource).toMatchObject({ alias: "box", script: "CLEAN",
      args: [worktree, remoteDir, "/remote/repo", task.id, ""] });
    await expect(validateConfiguredHostClean(ctx, grant)).resolves.toBeUndefined();
    await consumeConfiguredHostClean(ctx, grant);
    await expect(consumeConfiguredHostClean(ctx, grant)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(validateConfiguredHostClean(ctx, { ...grant })).rejects.toMatchObject({ code: "capability_denied" });
    const changed = await issueConfiguredHostClean(ctx, "box", task.id, false);
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy.replace("/remote/repo", "/remote/other"));
    await expect(validateConfiguredHostClean(ctx, changed)).rejects.toMatchObject({ code: "capability_denied" });
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy.replace("/remote/repo", "~/remote/repo"));
    expect((await issueConfiguredHostClean(ctx, "box", task.id, false)).resource.args[2]).toBe("~/remote/repo");
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy);
    await expect(issueConfiguredHostClean(ctx, "box", task.id, true))
      .rejects.toMatchObject({ code: "capability_denied" });
    const stale = await issueConfiguredHostClean(ctx, "box", task.id, false);
    updateTask(ctx, task.id, record => { record.state = "running"; });
    await expect(validateConfiguredHostClean(ctx, stale)).rejects.toMatchObject({ code: "capability_denied" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
