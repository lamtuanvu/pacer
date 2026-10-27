import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateOwnedConversationPending } from "../src/plugins/executor-conversation-pending";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

test("conversation pending result binds task, attempt, start and native owner before continuation", () => {
  const ctx = fakeCtx(), repo = tmpDir();
  const task = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 60, interactionMode: "conversation",
    conversation: { activity: "starting", agentSessionId: "native-fixture" } });
  const dir = join(ctx.pacerHome, "runs", task.id, "1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "started"), "100", { mode: 0o600 });
  writeFileSync(join(dir, "pid"), "123", { mode: 0o600 });
  writeFileSync(join(dir, "exit"), "0", { mode: 0o600 });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
    current.run = { dir, attempt: 1, executor: "codex", startedAt: 100,
      session: "interactive", interactionMode: "conversation",
      agentSession: { id: "native-fixture", source: "assigned" },
      mode: "current", workdir: repo, logFile: join(dir, "stdout") };
    current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
    current.childPid = 123;
  });
  const running = { status: "running", taskId: task.id, attempt: 1, startedAt: 100 };
  expect(() => validateOwnedConversationPending(ctx, "pacer-exec-direct", task.id, 1, running))
    .not.toThrow();
  rmSync(join(dir, "started"));
  expect(() => validateOwnedConversationPending(ctx, "pacer-exec-direct", task.id, 1, running))
    .toThrow();
  writeFileSync(join(dir, "started"), "100", { mode: 0o600 });
  rmSync(join(dir, "pid"));
  expect(() => validateOwnedConversationPending(ctx, "pacer-exec-direct", task.id, 1, running))
    .toThrow();
  writeFileSync(join(dir, "pid"), "123", { mode: 0o600 });
  for (const forged of [
    { ...running, taskId: "t-foreign" },
    { ...running, attempt: 2 },
    { ...running, startedAt: 101 },
    { ...running, dir: "/tmp/foreign" },
  ]) expect(() => validateOwnedConversationPending(ctx, "pacer-exec-direct", task.id, 1, forged))
    .toThrow();
  expect(() => validateOwnedConversationPending(ctx, "other-provider", task.id, 1, running))
    .toThrow();
  updateTask(ctx, task.id, current => { current.conversation = { activity: "working", agentSessionId: "swapped" }; });
  expect(() => validateOwnedConversationPending(ctx, "pacer-exec-direct", task.id, 1, running))
    .toThrow();
  updateTask(ctx, task.id, current => {
    current.conversation = { activity: "working", agentSessionId: "native-fixture" };
    delete current.run!.agentSession;
  });
  expect(() => validateOwnedConversationPending(ctx, "pacer-exec-direct", task.id, 1, running))
    .toThrow();
  updateTask(ctx, task.id, current => { current.run!.agentSession = { id: "native-fixture", source: "assigned" }; });
  writeFileSync(join(dir, "started"), "101", { mode: 0o600 });
  expect(() => validateOwnedConversationPending(ctx, "pacer-exec-direct", task.id, 1, running))
    .toThrow();
  writeFileSync(join(dir, "started"), "100", { mode: 0o600 });
  writeFileSync(join(dir, "pid"), "124", { mode: 0o600 });
  expect(() => validateOwnedConversationPending(ctx, "pacer-exec-direct", task.id, 1, running))
    .toThrow();
  updateTask(ctx, task.id, current => {
    current.conversation = { activity: "working", agentSessionId: "native-fixture" };
    current.interactionMode = undefined;
  });
  expect(() => validateOwnedConversationPending(ctx, "pacer-exec-direct", task.id, 1, running))
    .toThrow();
});
