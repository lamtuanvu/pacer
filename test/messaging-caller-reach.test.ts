import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { callOp } from "../src/api/ops";
import * as tasks from "../src/core/tasks";
import { callerAlive, callerReach, type CallerReach } from "../src/messaging/caller-reach";
import { readTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { fakeCtx, tmpDir, withLoginIndicators } from "./helpers";

const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "/x");
const ALL = {
  CLAUDE_CODE_SESSION_ID: "ses-native", PACER_PLANNER_SESSION: "claude-code:ses-planner", CODEX_THREAD_ID: "codex-thread",
  CLAUDE_PID: String(process.pid), ORCA_TERMINAL_HANDLE: "orca-1", ORCA_PANE_KEY: "pane-7", TMUX_PANE: "%3", TERM_SESSION_ID: "TERM-1",
};
const PARTICIPANT = "external:claude-code:ses-planner";

async function delegateCtx(env: Record<string, string | undefined>) {
  const ctx = withLoginIndicators(fakeCtx({ env }));
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  return ctx;
}
const delegate = async (ctx: Ctx) =>
  readTask(ctx, (await callOp(ctx, "task.delegate", { goal: "g", repo: tmpDir() }, { spawnRunner: () => 1 }) as { task_id: string }).task_id)!;

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

test("reach is only stored for the caller's own participant", async () => {
  const ctx = await delegateCtx(ALL);
  const params = {
    goal: "g", repo: tmpDir(),
    callerReach: { participant: "external:evil", session: "evil-session", terminal: { kind: "orca", handle: "evil" }, cwd: "/evil", at: 1 },
    session: "evil-session",
  };
  const task = readTask(ctx, (await callOp(ctx, "task.delegate", params, { spawnRunner: () => 1 }) as { task_id: string }).task_id)!;
  expect(task.callerReach).toMatchObject({ participant: PARTICIPANT, session: "ses-native", terminal: { kind: "orca", handle: "orca-1" }, at: ctx.now });
  expect(task.callerReach?.session).not.toBe("evil-session");
  expect(task.origin).toBe(PARTICIPANT);
});

test("reused pid is not the caller", async () => {
  const ctx = fakeCtx({ env: { CLAUDE_PID: String(process.pid) } });
  const reach = callerReach(ctx, "external:local")!;
  expect(reach.process?.pid).toBe(process.pid);
  expect(await callerAlive(ctx, reach)).toBe(true);
  const reused: CallerReach = { ...reach, process: { ...reach.process!, birth: "1:1" } };
  expect(await callerAlive(ctx, reused)).toBe(false);
  expect(await callerAlive(ctx, { ...reach, process: undefined })).toBe(false);
});

test("retries keep the original reach", async () => {
  const ctx = await delegateCtx(ALL);
  const original = await delegate(ctx);
  expect(original.callerReach).toBeDefined();
  const r = await tasks.retry(ctx, original.id, {}, { delegate: (c, input) => tasks.delegate(c, input, () => 1, s) });
  const retried = readTask(ctx, r.retry.id)!;
  expect(retried.callerReach).toEqual(original.callerReach);
  expect(retried.callerReach?.session).toBe("ses-native");
});
