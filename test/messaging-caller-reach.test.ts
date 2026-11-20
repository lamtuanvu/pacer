import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { validateStrategy } from "../src/config/strategy";
import { callOp } from "../src/api/ops";
import { cliDeps, main } from "../src/cli";
import * as tasks from "../src/core/tasks";
import { createMcpServer } from "../src/mcp/server";
import { callerAlive, callerReach, type CallerReach } from "../src/messaging/caller-reach";
import { readTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { fakeCtx, gitRepo, realRun, tmpDir, withLoginIndicators } from "./helpers";

const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "/x");
const ALL = {
  CLAUDE_CODE_SESSION_ID: "ses-native", PACER_PLANNER_SESSION: "claude-code:ses-planner", CODEX_THREAD_ID: "codex-thread",
  CLAUDE_PID: String(process.pid), ORCA_TERMINAL_HANDLE: "orca-1", ORCA_PANE_KEY: "pane-7", TMUX_PANE: "%3", TERM_SESSION_ID: "TERM-1",
};
const PARTICIPANT = "external:claude-code:ses-planner";

async function delegateCtx(env: Record<string, string | undefined>, o: Partial<Ctx> = {}) {
  const ctx = withLoginIndicators(fakeCtx({ ...o, env }));
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  return ctx;
}
test("records an Orca caller", () => {
  const ctx = fakeCtx({ env: ALL });
  const reach = callerReach(ctx, PARTICIPANT)!;
  expect(reach.terminal).toEqual({ kind: "orca", handle: "orca-1", paneKey: "pane-7" });
  expect(reach.session).toBe("ses-native");
  expect(reach.process).toMatchObject({ pid: process.pid });
  expect(reach.participant).toBe(PARTICIPANT);
  expect(reach.cwd).toBe(process.cwd());
  expect(reach.at).toBe(ctx.now);
});

test("a plain terminal is uncontrolled", () => {
  const plain = callerReach(fakeCtx({ env: { TERM_SESSION_ID: "AAAA-BBBB" } }), "external:local")!;
  expect(plain.terminal).toEqual({ kind: "uncontrolled" });
  expect(plain.session).toBeUndefined();
  expect(callerReach(fakeCtx({ env: { TMUX_PANE: "%9" } }), "external:local")!.terminal).toEqual({ kind: "tmux", pane: "%9" });
});

test("human and executor callers get no reach", () => {
  const ctx = fakeCtx({ env: ALL });
  expect(callerReach(ctx, "human")).toBeNull();
  expect(callerReach(ctx, "task:t-20261118-000000-0000")).toBeNull();
});

test("the op path records no reach and params cannot carry one", async () => {
  const ctx = await delegateCtx(ALL);
  const params = {
    goal: "g", repo: tmpDir(),
    callerReach: { participant: "external:evil", session: "evil-session", terminal: { kind: "orca", handle: "evil" }, cwd: "/evil", at: 1 },
    session: "evil-session",
  };
  const task = readTask(ctx, (await callOp(ctx, "task.delegate", params, { spawnRunner: () => 1 }) as { task_id: string }).task_id)!;
  expect(task.callerReach).toBeUndefined();
  expect(task.origin).toBe(PARTICIPANT);
});

test("a process is recorded only from an explicit planner pid", () => {
  expect(callerReach(fakeCtx({ env: { PACER_PLANNER_SESSION: "claude-code:ses-planner" } }), PARTICIPANT)!.process).toBeUndefined();
  expect(callerReach(fakeCtx({ env: { ...ALL, CLAUDE_PID: "not-a-pid" } }), PARTICIPANT)!.process).toBeUndefined();
});

test("reused pid is not the caller", async () => {
  const ctx = fakeCtx({ env: { CLAUDE_PID: String(process.pid) } });
  const reach = callerReach(ctx, "external:local")!;
  expect(reach.process?.pid).toBe(process.pid);
  expect(await callerAlive(ctx, reach)).toBe("alive");
  const reused: CallerReach = { ...reach, process: { ...reach.process!, birth: "1:1" } };
  expect(await callerAlive(ctx, reused)).toBe("gone");
  expect(await callerAlive(ctx, { ...reach, process: undefined })).toBe("unknown");
});

test("an exited caller is gone, not unknown", async () => {
  const child = Bun.spawn(["sleep", "30"]);
  try {
    const ctx = fakeCtx({ env: { CLAUDE_PID: String(child.pid) } });
    const reach = callerReach(ctx, "external:local")!;
    expect(await callerAlive(ctx, reach)).toBe("alive");
    child.kill(); await child.exited;
    expect(await callerAlive(ctx, reach)).toBe("gone");
  } finally { child.kill(); }
});

test("the CLI delegate records the caller reach", async () => {
  const ctx = await delegateCtx(ALL, { run: realRun });
  const original = cliDeps.spawnRunner;
  cliDeps.spawnRunner = () => 1;
  try {
    const r = await main(["delegate", "--goal", "g", "--repo", gitRepo(), "--json"], ctx);
    expect(r.code).toBe(0);
    const task = readTask(ctx, JSON.parse(r.out).id)!;
    expect(task.callerReach).toMatchObject({
      participant: PARTICIPANT, session: "ses-native", terminal: { kind: "orca", handle: "orca-1", paneKey: "pane-7" }, at: ctx.now,
    });
    expect(task.origin).toBe(PARTICIPANT);
  } finally { cliDeps.spawnRunner = original; }
});

test("the MCP delegate records the caller reach", async () => {
  const ctx = await delegateCtx(ALL);
  const server = createMcpServer(() => ctx, { spawnRunner: () => 1 });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(ct);
  try {
    const r = await client.callTool({ name: "delegate", arguments: { goal: "g", repo: tmpDir() } }) as { structuredContent?: { task_id: string } };
    const task = readTask(ctx, r.structuredContent!.task_id)!;
    expect(task.callerReach).toMatchObject({
      participant: PARTICIPANT, session: "ses-native", terminal: { kind: "orca", handle: "orca-1", paneKey: "pane-7" }, at: ctx.now,
    });
    expect(task.origin).toBe(PARTICIPANT);
  } finally { await client.close(); await server.close(); }
});

test("retries keep the original reach", async () => {
  const ctx = await delegateCtx(ALL);
  const reach = callerReach(ctx, PARTICIPANT)!;
  const original = await tasks.delegate(ctx, { brief: { goal: "g", repo: tmpDir() }, origin: PARTICIPANT, callerReach: reach }, () => 1, s);
  expect(original.callerReach).toEqual(reach);
  const r = await tasks.retry(ctx, original.id, {}, { delegate: (c, input) => tasks.delegate(c, input, () => 1, s) });
  const retried = readTask(ctx, r.retry.id)!;
  expect(retried.callerReach).toEqual(original.callerReach);
  expect(retried.callerReach?.session).toBe("ses-native");
});
