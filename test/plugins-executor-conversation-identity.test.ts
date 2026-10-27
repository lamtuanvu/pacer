import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitOwnedConversationIdentity, discoverOwnedConversationIdentity } from "../src/plugins/executor-conversation-identity";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

const createArgv = (taskId: string) => ["opencode", "api", "--standalone", "session.create", "--data",
  JSON.stringify({ title: `pacer ${taskId}`, agent: "build" })];
const lookupArgv = (id: string) => ["opencode", "api", "--standalone", "session.get", "--param", `sessionID=${id}`];

function owner(executor = "opencode") {
  const ctx = fakeCtx(), workdir = tmpDir();
  const task = createTask(ctx, { brief: { goal: "fixture", repo: workdir }, kind: null,
    requestedExecutor: executor, timeoutS: 60, interactionMode: "conversation",
    conversation: { activity: "starting" } });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = executor;
    current.executorProvider = "pacer-exec-direct";
  });
  return { ctx, taskId: task.id, workdir };
}

test("lost native create reply stays uncertain and never creates a second session", async () => {
  const { ctx, taskId, workdir } = owner();
  let creates = 0;
  const deps = {
    plan: async () => ({ kind: "command" as const, argv: createArgv(taskId), idPath: ["data", "id"] }),
    command: async () => { creates++; return { code: 0, timedOut: false, stdout: "{" }; },
  };
  const call = () => admitOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct",
    "opencode", { agent: "opencode", version: "2.1.2", taskId }, workdir, {}, deps);
  await expect(call()).rejects.toThrow();
  expect(readTask(ctx, taskId)?.nativeIdentityIntent).toMatchObject({ kind: "create", attempt: 1 });
  await expect(call()).rejects.toThrow();
  expect(creates).toBe(1);
  expect(readTask(ctx, taskId)?.conversation?.agentSessionId).toBeUndefined();
});

test("definite native create receipt persists once for the same attempt", async () => {
  const { ctx, taskId, workdir } = owner();
  let creates = 0;
  const deps = {
    plan: async () => ({ kind: "command" as const, argv: createArgv(taskId), idPath: ["data", "id"] }),
    command: async () => { creates++; return { code: 0, timedOut: false,
      stdout: '{"data":{"id":"native-created"}}' }; },
  };
  const call = () => admitOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct",
    "opencode", { agent: "opencode", version: "2.1.2", taskId }, workdir, {}, deps);
  expect(await call()).toEqual({ id: "native-created", source: "assigned" });
  expect(await call()).toEqual({ id: "native-created", source: "assigned" });
  expect(creates).toBe(1);
  expect(readTask(ctx, taskId)?.conversation?.agentSessionId).toBe("native-created");
});

test("lost read-only lookup can retry only the exact existing native ID", async () => {
  const { ctx, taskId, workdir } = owner();
  updateTask(ctx, taskId, current => { current.conversation = { activity: "starting", agentSessionId: "known-id" }; });
  let reads = 0;
  const deps = {
    plan: async () => ({ kind: "command" as const, argv: lookupArgv("known-id"), idPath: ["data", "id"] }),
    command: async () => { reads++; return { code: 0, timedOut: false,
      stdout: reads === 1 ? "{" : '{"data":{"id":"known-id"}}' }; },
  };
  const call = () => admitOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct",
    "opencode", { agent: "opencode", version: "2.1.2", taskId }, workdir, {}, deps);
  await expect(call()).rejects.toThrow();
  expect(readTask(ctx, taskId)?.nativeIdentityIntent).toMatchObject({ kind: "lookup", requestedId: "known-id" });
  expect(await call()).toEqual({ id: "known-id", source: "lookup" });
  expect(reads).toBe(2);
});

test("a changed lookup plan and a mismatched selected agent never execute", async () => {
  const { ctx, taskId, workdir } = owner();
  updateTask(ctx, taskId, task => { task.conversation = { activity: "starting", agentSessionId: "known-id" }; });
  let commands = 0;
  const plan = async () => ({ kind: "command" as const, argv: createArgv(taskId), idPath: ["data", "id"] });
  const command = async () => { commands++; return { code: 0, timedOut: false,
    stdout: '{"data":{"id":"known-id"}}' }; };
  await expect(admitOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct", "opencode",
    { agent: "claude-code", version: "2.1.2", taskId }, workdir, {}, { plan, command }))
    .rejects.toThrow();
  await expect(admitOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct", "opencode",
    { agent: "opencode", version: "2.1.2", taskId }, workdir, {}, { plan, command }))
    .rejects.toThrow();
  await expect(admitOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct", "opencode",
    { agent: "opencode", version: "2.1.2", taskId }, workdir, {}, {
      plan: async () => ({ kind: "assigned" as const, id: "known-id" }), command,
    })).rejects.toThrow();
  expect(commands).toBe(0);
  expect(readTask(ctx, taskId)?.nativeIdentityIntent).toBeUndefined();
});

test("assigned identity is durable and bound to the same owner", async () => {
  const { ctx, taskId, workdir } = owner("claude-code");
  let plans = 0;
  const deps = {
    plan: async () => { plans++; return { kind: "assigned" as const, id: "native-fixture" }; },
    command: async () => { throw Error("no command"); },
  };
  const call = () => admitOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct",
    "claude-code", { agent: "claude-code", version: "2.1.2", taskId }, workdir, {}, deps);
  expect(await call()).toEqual({ id: "native-fixture", source: "assigned" });
  expect(await call()).toEqual({ id: "native-fixture", source: "assigned" });
  expect(plans).toBe(1);
  expect(readTask(ctx, taskId)?.conversation?.agentSessionId).toBe("native-fixture");
  updateTask(ctx, taskId, current => { current.executorProvider = "foreign"; });
  await expect(call()).rejects.toThrow();
});

test("header-only identity permits the first claim without inventing a native ID", async () => {
  const { ctx, taskId, workdir } = owner("codex");
  const deps = {
    plan: async () => ({ kind: "none" as const }),
    command: async () => { throw Error("no command"); },
  };
  expect(await admitOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct",
    "codex", { agent: "codex", version: "2.1.2", taskId }, workdir, {}, deps)).toBeUndefined();
  expect(readTask(ctx, taskId)?.nativeIdentityIntent).toMatchObject({ kind: "header", attempt: 1 });
  const dir = join(ctx.pacerHome, "runs", taskId, "1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "started"), "100", { mode: 0o600 });
  writeFileSync(join(dir, "pid"), "123", { mode: 0o600 });
  writeFileSync(join(dir, "stdout"), "startup without identity", { mode: 0o600 });
  updateTask(ctx, taskId, task => {
    task.run = { dir, attempt: 1, executor: "codex", startedAt: 100,
      session: "interactive", interactionMode: "conversation", mode: "current",
      workdir, logFile: join(dir, "stdout") };
    task.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
  });
  // A crash after process start but before host PID publication cannot bind
  // an agent-writable marker as if it were host authority.
  expect(() => discoverOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct", 1)).toThrow();
  updateTask(ctx, taskId, task => { task.childPid = 123; });
  expect(discoverOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct", 1)).toBeUndefined();
  const id = "12345678-1234-1234-1234-123456789abc";
  writeFileSync(join(dir, "stdout"), `session id: ${id}\n`, { mode: 0o600 });
  expect(discoverOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct", 1))
    .toEqual({ id, source: "header" });
  expect(readTask(ctx, taskId)?.run?.agentSession?.id).toBe(id);
  expect(readTask(ctx, taskId)?.conversation?.agentSessionId).toBe(id);
  writeFileSync(join(dir, "started"), "101", { mode: 0o600 });
  expect(() => discoverOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct", 1)).toThrow();
  writeFileSync(join(dir, "started"), "100", { mode: 0o600 });
  writeFileSync(join(dir, "pid"), "124", { mode: 0o600 });
  expect(() => discoverOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct", 1)).toThrow();
  writeFileSync(join(dir, "pid"), "123", { mode: 0o600 });
  unlinkSync(join(dir, "started"));
  writeFileSync(join(dir, "foreign-start"), "100", { mode: 0o600 });
  symlinkSync(join(dir, "foreign-start"), join(dir, "started"));
  expect(() => discoverOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct", 1)).toThrow();
});

test("a resumed native identity cannot silently become header-only", async () => {
  const { ctx, taskId, workdir } = owner("codex");
  updateTask(ctx, taskId, task => { task.conversation = { activity: "starting", agentSessionId: "known-id" }; });
  const deps = {
    plan: async () => ({ kind: "none" as const }),
    command: async () => { throw Error("no command"); },
  };
  await expect(admitOwnedConversationIdentity(ctx, taskId, "pacer-exec-direct",
    "codex", { agent: "codex", version: "2.1.2", taskId }, workdir, {}, deps)).rejects.toThrow();
  expect(readTask(ctx, taskId)?.nativeIdentityIntent).toBeUndefined();
});
