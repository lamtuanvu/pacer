import { expect, test } from "bun:test";
import { ApiError, type ApiClient } from "../src/api/client";
import { emptySnapshot, type CmdData, type LinkSnapshot, type TaskData } from "../src/link/envelope";
import { cmdToOp, runCommand, delegateViaClient, refreshView } from "../src/dashboard/data";

const task = (id: string, state = "running"): TaskData => ({ id, state, goal: id, executor: "codex", backend: "direct", worktree: null, updatedAt: 1 });
const snap = (tasks: TaskData[]): LinkSnapshot => ({ ...emptySnapshot(), seq: 1, tasks });
const fake = (s: LinkSnapshot): ApiClient => ({ kind: "inprocess", hello: async () => ({ protocol: "2.0.0", pacer: "0", ops: [], events: [] }), snapshot: async () => ({ protocol: "2.0.0", seq: s.seq, snapshot: s }), call: async () => { throw new Error("unused"); }, subscribe: () => () => {}, close: () => {} });

test("refresh keeps the selected card by id, else clamps", async () => {
  const before = snap([task("a"), task("b"), task("c")]);
  const reordered = snap([task("c"), task("b"), task("a")]);
  const r1 = await refreshView(fake(reordered), { snapshot: before, selected: 1, now: 10 });
  expect(r1.selected).toBe(1);
  expect(r1.snapshot).toBe(reordered);
  const r2 = await refreshView(fake(reordered), { snapshot: before, selected: 2, now: 10 });
  expect(r2.selected).toBe(0);
  const r3 = await refreshView(fake(snap([task("x")])), { snapshot: before, selected: 2, now: 10 });
  expect(r3.selected).toBe(0);
  const r4 = await refreshView(fake(snap([])), { snapshot: before, selected: 2, now: 10 });
  expect(r4.selected).toBe(0);
  const r5 = await refreshView(fake(reordered), { snapshot: before, selected: -1, now: 10 });
  expect(r5.selected).toBe(0);
});


test("cmdToOp maps exactly the op-backed commands", () => {
  expect(cmdToOp({ cmd: "stop", taskId: "t1" })).toEqual({ op: "task.stop", params: { id: "t1" } });
  expect(cmdToOp({ cmd: "retry", taskId: "t1", executor: "codex" })).toEqual({ op: "task.retry", params: { id: "t1", executor: "codex" } });
  expect(cmdToOp({ cmd: "retry", taskId: "t1" })).toEqual({ op: "task.retry", params: { id: "t1" } });
  expect(cmdToOp({ cmd: "dismiss", taskIds: ["a", "b"] })).toEqual({ op: "task.dismiss", params: { ids: ["a", "b"] } });
  expect(cmdToOp({ cmd: "dismiss", taskId: "a" })).toEqual({ op: "task.dismiss", params: { ids: ["a"] } });
  expect(cmdToOp({ cmd: "block", executor: "codex" })).toEqual({ op: "runner.block", params: { id: "codex" } });
  const block = { cmd: "block" as const, executor: "codex", for: "1h", reason: "reserved" };
  expect(cmdToOp(block)).toEqual({ op: "runner.block", params: { id: "codex", for: "1h", reason: "reserved" } });
  expect(cmdToOp({ cmd: "unblock", executor: "codex" })).toEqual({ op: "runner.unblock", params: { id: "codex" } });
  expect(cmdToOp({ cmd: "use", strategy: "night" })).toEqual({ op: "strategy.use", params: { name: "night" } });
  for (const cmd of ["use", "check-setup", "check-updates", "update", "focus", "retry-all", "strategy-build", "notify-level", "refresh", "config-set", "account-remove", "runner-remove", "open-terminal"] as const) expect(cmdToOp({ cmd })).toBeNull();
});

test("op errors become pacer: messages; unmapped commands use the fallback", async () => {
  const reports: string[] = [], fell: string[] = [];
  const client = { ...fake(snap([])), call: async () => { throw new ApiError("conflict", "retry t-2 is already queued", "wait for it"); } };
  await runCommand(client, { cmd: "retry", taskId: "t1" }, async (d) => { fell.push(d.cmd); }, (s) => reports.push(s));
  expect(reports).toEqual(["pacer: retry t-2 is already queued (wait for it)"]);
  await runCommand(client, { cmd: "check-updates" }, async (d) => { fell.push(d.cmd); }, (s) => reports.push(s));
  expect(fell).toEqual(["check-updates"]);
});

test("op results produce dashboard success messages", async () => {
  const reports: string[] = [];
  const results: Record<string, unknown> = {
    "task.stop": { task_id: "t1", state: "stopped" },
    "task.retry": { retry: { task_id: "t2" }, of: { task_id: "t1" } },
    "task.dismiss": { dismissed: ["a", "b"], unknown: ["c"] },
    "runner.block": { ok: true }, "runner.unblock": { ok: true },
    "strategy.use": { name: "night", path: "strategy.yaml" },
  };
  const client: ApiClient = { ...fake(snap([])), call: async <T>(op: string) => results[op] as T };
  const fallback = async () => { throw new Error("unexpected fallback"); };
  const commands: CmdData[] = [{ cmd: "stop", taskId: "t1" }, { cmd: "retry", taskId: "t1" }, { cmd: "dismiss", taskIds: ["a", "b", "c"] }, { cmd: "block", executor: "codex" }, { cmd: "unblock", executor: "codex" }, { cmd: "use", strategy: "night" }];
  for (const data of commands) {
    await runCommand(client, data, fallback, s => reports.push(s));
  }
  expect(reports).toEqual(["t1 stopped", "t2 queued (retry of t1)", "dismissed 2; unknown: c", "blocked codex", "unblocked codex", "active strategy: night"]);
});

test("delegateViaClient sends prompt fields and reports queued tasks and errors", async () => {
  const reports: string[] = [], calls: unknown[] = [];
  const client: ApiClient = { ...fake(snap([])), call: async <T>(op: string, params?: unknown) => { calls.push({ op, params }); return { task_id: "t3" } as T; } };
  await delegateViaClient(client, { goal: "g", repo: "repo", kind: "test" }, s => reports.push(s));
  await delegateViaClient(client, { goal: "g", repo: "repo" }, s => reports.push(s));
  expect(calls).toEqual([{ op: "task.delegate", params: { goal: "g", repo: "repo", kind: "test" } }, { op: "task.delegate", params: { goal: "g", repo: "repo" } }]);
  expect(reports).toEqual(["t3 queued", "t3 queued"]);
  client.call = async () => { throw new ApiError("invalid_input", "bad kind"); };
  await delegateViaClient(client, { goal: "g", repo: "repo" }, s => reports.push(s));
  expect(reports.at(-1)).toBe("pacer: bad kind");
});
