import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueConfiguredHostSessionStream, consumeConfiguredHostSessionStream,
  validateConfiguredHostSessionStream } from "../src/plugins/host-session-stream-issuer";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

test("full-session stream grant is one use, pins admission rev and survives report rev churn", () => {
  const home = tmpDir(), pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { recursive: true });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n    session: full\n");
  const ctx = fakeCtx({ home, pacerHome });
  const task = createTask(ctx, { brief: { goal: "view", repo: home }, kind: null,
    requestedExecutor: null, timeoutS: 60 });
  const local = join(pacerHome, "runs", task.id, "1");
  const remote = `/remote/.pacer-remote/runs/${task.id}/1`;
  updateTask(ctx, task.id, record => { record.run = { host: "box", mode: "new", remoteDir: remote,
    remoteWorktree: "/remote/worktree", workdir: "/remote/worktree", dir: local, attempt: 1,
    executor: "codex@box", startedAt: 1, logFile: "unused" }; });
  const grant = issueConfiguredHostSessionStream(ctx, "box", remote, local);
  updateTask(ctx, task.id, record => { record.state = "running"; });
  expect(() => consumeConfiguredHostSessionStream(ctx, grant)).toThrow();
  const viewer = issueConfiguredHostSessionStream(ctx, "box", remote, local);
  consumeConfiguredHostSessionStream(ctx, viewer);
  updateTask(ctx, task.id, record => { record.state = "running"; });
  expect(() => validateConfiguredHostSessionStream(ctx, viewer)).not.toThrow();
  expect(() => consumeConfiguredHostSessionStream(ctx, viewer)).toThrow();
  updateTask(ctx, task.id, record => { record.run!.remoteDir = remote.replace("/1", "/2"); });
  expect(() => validateConfiguredHostSessionStream(ctx, viewer)).toThrow();
});

test("session stream refuses a configured recording host before issuance", () => {
  const home = tmpDir(), pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { recursive: true });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n    session: recording\n");
  const ctx = fakeCtx({ home, pacerHome });
  const task = createTask(ctx, { brief: { goal: "view", repo: home }, kind: null,
    requestedExecutor: null, timeoutS: 60 });
  const local = join(pacerHome, "runs", task.id, "1");
  const remote = `/remote/.pacer-remote/runs/${task.id}/1`;
  updateTask(ctx, task.id, record => { record.run = { host: "box", mode: "new", remoteDir: remote,
    remoteWorktree: "/remote/worktree", workdir: "/remote/worktree", dir: local, attempt: 1,
    executor: "codex@box", startedAt: 1, logFile: "unused" }; });
  expect(() => issueConfiguredHostSessionStream(ctx, "box", remote, local)).toThrow();
});
