import { expect, test } from "bun:test";
import { readActivity } from "../src/activity/log";
import { callOp } from "../src/api/ops";
import { CoreError } from "../src/core/errors";
import { callerIdentity, send } from "../src/session/send";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { LiveWorker } from "../src/tasks/types";
import { fakeCtx, gitRepo } from "./helpers";
import { fakeRun, raw, type Route } from "./fixtures/orca/fake";

const TERM = "term_a225e7a8-0e55-4cb9-8e30-be7da4952e5d";
const envelope = (result: object) => raw(JSON.stringify({ ok: true, result }));
const O = (...args: string[]) => ["orca", ...args];
const LIVE: LiveWorker = { backend: "orca", worker: "ctx_live", terminal: TERM, executor: "codex", agent: "codex", incarnation: "inc-1", since: 1 };
const agentShown = (over: object = {}) => [O("terminal", "show"), envelope({ terminal: { handle: TERM, incarnationId: "inc-1", connected: true, writable: true, agentIdentity: "codex", ...over } })] as Route;

function setup(over: Route[] = []) {
  const f = fakeRun([
    ...over,
    [O("orchestration", "worker-show"), envelope({ worker: { state: "running" } })],
    agentShown(),
    [O("terminal", "send"), envelope({})],
  ]);
  const ctx = fakeCtx({ run: f.run });
  const task = createTask(ctx, { brief: { goal: "g", repo: gitRepo() }, kind: null, requestedExecutor: "codex", timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.interactionMode = "conversation"; t.live = LIVE; });
  const sends = () => f.calls.filter(a => a[1] === "terminal" && a[2] === "send");
  return { f, ctx, task, sends };
}

const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as CoreError).code; } };

test("send delivers text into the lane's live agent and records it on the timeline", async () => {
  const { f, ctx, task } = setup();
  ctx.env = { ...ctx.env, USER: "alice", ORCA_TERMINAL_HANDLE: "term_planner" };
  const updated = await send(ctx, task.id, "go with plan B");
  expect(f.calls).toContainEqual(["orca", "terminal", "send", "--terminal", TERM, "--text", "go with plan B", "--enter", "--json"]);
  expect(updated.driving).toEqual({ by: "alice@term_planner", at: ctx.now });
  const { entries } = readActivity(ctx, { taskId: task.id, kinds: ["message"] });
  expect(entries).toHaveLength(1);
  expect(entries[0].text).toContain("go with plan B");
});

test("a task with no live worker is unavailable, not a policy refusal", async () => {
  const { ctx, task, sends } = setup();
  updateTask(ctx, task.id, t => { delete t.live; });
  await expect(send(ctx, task.id, "hi")).rejects.toThrow("this task has no live terminal to send into");
  expect(await code(send(ctx, task.id, "hi"))).toBe("unavailable");
  expect(sends()).toHaveLength(0);
});

test("a backend without the live capability refuses as unavailable", async () => {
  const { ctx, task, sends } = setup();
  updateTask(ctx, task.id, t => { t.live = { ...LIVE, backend: "direct" }; });
  await expect(send(ctx, task.id, "hi")).rejects.toThrow("the direct backend cannot deliver live input");
  expect(await code(send(ctx, task.id, "hi"))).toBe("unavailable");
  expect(sends()).toHaveLength(0);
});

test("nothing is typed when a shell, not the agent, is in the terminal's foreground", async () => {
  const { ctx, task, sends } = setup([agentShown({ agentIdentity: null })]);
  await expect(send(ctx, task.id, "rm -rf build")).rejects.toThrow(/codex is not in the foreground \(a shell may be\)/);
  expect(await code(send(ctx, task.id, "rm -rf build"))).toBe("unavailable");
  expect(sends()).toHaveLength(0);
  expect(readTask(ctx, task.id)?.driving).toBeUndefined(); // the claimed lease is given back
});

test("nothing is typed into another agent, a restarted terminal or a settled worker", async () => {
  for (const [route, why] of [
    [agentShown({ agentIdentity: "claude" }), /claude, not codex, is in the foreground/],
    [agentShown({ incarnationId: "inc-2" }), /the terminal was restarted/],
    [[O("orchestration", "worker-show"), envelope({ worker: { state: "succeeded" } })] as Route, /the worker is succeeded/],
  ] as [Route, RegExp][]) {
    const { ctx, task, sends } = setup([route]);
    await expect(send(ctx, task.id, "hi")).rejects.toThrow(why);
    expect(sends()).toHaveLength(0);
  }
});

test("send refuses a task that is not running", async () => {
  const { ctx, task } = setup();
  updateTask(ctx, task.id, t => { t.state = "done"; });
  await expect(send(ctx, task.id, "hi")).rejects.toThrow("task is done, not running");
});

test("send refuses a lane waiting on its question: no runner supervises the kept-alive worker, so it is answered instead", async () => {
  const { ctx, task, sends } = setup();
  updateTask(ctx, task.id, t => { t.state = "needs_input"; t.question = { text: "A or B?", at: 1 }; });
  await expect(send(ctx, task.id, "use B")).rejects.toThrow(`task is waiting for an answer; use pacer answer ${task.id}`);
  expect(await code(send(ctx, task.id, "use B"))).toBe("conflict");
  expect(sends()).toHaveLength(0);
  expect(readTask(ctx, task.id)?.driving).toBeUndefined();
});

test("send refuses empty or oversized text", async () => {
  const { ctx, task } = setup();
  for (const text of ["", "   ", "x".repeat(4001)]) await expect(send(ctx, task.id, text)).rejects.toThrow();
});

test("executors cannot use pacer send", async () => {
  const { ctx, task } = setup();
  ctx.env = { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id };
  await expect(send(ctx, task.id, "hi")).rejects.toThrow("executors cannot use pacer send");
});

test("a second send within the lease window is refused unless forced", async () => {
  const { ctx, task } = setup();
  await send(ctx, task.id, "first", { by: "operator-a" });
  await expect(send(ctx, task.id, "second", { by: "operator-b" })).rejects.toThrow(/operator-a sent a message \d+s ago; use --force/);
  const forced = await send(ctx, task.id, "second", { by: "operator-b", force: true });
  expect(forced.driving).toEqual({ by: "operator-b", at: ctx.now });
  const { entries } = readActivity(ctx, { taskId: task.id, kinds: ["message"] });
  expect(entries[0]?.text).toContain("took over from operator-a");
});

test("sending again with the same identity never needs --force", async () => {
  const { ctx, task } = setup();
  await send(ctx, task.id, "first", { by: "planner" });
  await expect(send(ctx, task.id, "second", { by: "planner" })).resolves.toBeTruthy();
});

test("unknown task and bad id are reported as CoreError", async () => {
  const ctx = fakeCtx();
  await expect(send(ctx, "t-20261016-000000-abcd", "hi")).rejects.toBeInstanceOf(CoreError);
  await expect(send(ctx, "../escape", "hi")).rejects.toBeInstanceOf(CoreError);
});

test("the CLI identity is the planner's terminal, so two planners of one OS user contend", async () => {
  const { ctx, task } = setup();
  const first = { ...ctx, env: { ...ctx.env, USER: "alice", ORCA_TERMINAL_HANDLE: "term_one" } };
  const second = { ...ctx, env: { ...ctx.env, USER: "alice", ORCA_TERMINAL_HANDLE: "term_two" } };
  expect(callerIdentity(first)).toBe("alice@term_one");
  expect(callerIdentity(first, "app/1.2.0")).toBe("client:app/1.2.0");
  await send(first, task.id, "one");
  await expect(send(first, task.id, "again")).resolves.toBeTruthy();
  await expect(send(second, task.id, "two")).rejects.toThrow(/alice@term_one sent a message/);
});

test("two service clients sending at once: one is delivered, the other gets conflict", async () => {
  const { ctx, task, sends } = setup();
  const results = await Promise.allSettled([
    callOp(ctx, "task.send", { id: task.id, text: "from the app" }, { client: "app/1.2.0" }),
    callOp(ctx, "task.send", { id: task.id, text: "from a planner" }, { client: "mcp/stdio" }),
  ]);
  expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  const refused = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  expect((refused.reason as CoreError).code).toBe("conflict");
  expect(refused.reason.message).toContain("client:app/1.2.0 sent a message");
  expect(sends()).toHaveLength(1);
  expect(readTask(ctx, task.id)?.driving?.by).toBe("client:app/1.2.0");
});

test("a stop that lands first is seen by the send's state check", async () => {
  const { ctx, task, sends } = setup();
  updateTask(ctx, task.id, t => { t.state = "stopped"; });
  expect(await code(callOp(ctx, "task.send", { id: task.id, text: "hi" }, { client: "app/1.2.0" }))).toBe("conflict");
  expect(sends()).toHaveLength(0);
});

test("send rejects a stale expectRev and accepts a matching one", async () => {
  const { ctx, task } = setup();
  const currentRev = readTask(ctx, task.id)!.rev;
  await expect(send(ctx, task.id, "hi", { expectRev: currentRev + 1 })).rejects.toThrow();
  await expect(send(ctx, task.id, "hi", { expectRev: currentRev })).resolves.toBeTruthy();
});
