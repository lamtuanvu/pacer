import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueConfiguredHostStop, consumeConfiguredHostStop, validateConfiguredHostStop } from "../src/plugins/host-stop-issuer";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

test("STOP grant pins one persisted remote run and grace", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-host-stop-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { recursive: true });
  try {
    const strategy = "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n";
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy);
    const ctx = fakeCtx({ home, pacerHome });
    const task = createTask(ctx, { brief: { goal: "run", repo: home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    const local = join(pacerHome, "runs", task.id, "1");
    const remote = `/remote/.pacer-remote/runs/${task.id}/1`;
    updateTask(ctx, task.id, record => { record.state = "running";
      record.run = { host: "box", mode: "new", remoteDir: remote, remoteWorktree: "/remote/worktree",
        workdir: "/remote/worktree", dir: local, attempt: 1, executor: "codex@box", startedAt: 1, logFile: "unused" }; });
    const grant = issueConfiguredHostStop(ctx, "box", remote, local, 5);
    expect(grant.resource).toMatchObject({ alias: "box", script: "STOP", args: [remote, "5"] });
    expect(() => validateConfiguredHostStop(ctx, grant)).not.toThrow();
    consumeConfiguredHostStop(ctx, grant);
    expect(() => consumeConfiguredHostStop(ctx, grant)).toThrow();
    expect(() => validateConfiguredHostStop(ctx, { ...grant })).toThrow();
    const stale = issueConfiguredHostStop(ctx, "box", remote, local, 5);
    updateTask(ctx, task.id, record => { record.run!.remoteDir = "/remote/changed"; });
    expect(() => validateConfiguredHostStop(ctx, stale)).toThrow();
    expect(() => issueConfiguredHostStop(ctx, "box", remote, local, 0)).toThrow();
    expect(() => issueConfiguredHostStop(ctx, "box", `${remote}/../1`, local, 5)).toThrow();
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy.replace("ssh-fixture", "ssh-other"));
    expect(() => validateConfiguredHostStop(ctx, grant)).toThrow();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
