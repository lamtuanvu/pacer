import { expect, test } from "bun:test";
import { ApiError } from "../app/src/data/api";
import { createActionRunner, uiHref } from "../app/src/data/actions";
import type { Action } from "../src/api/read-model/types";

function deps(over: Partial<Parameters<typeof createActionRunner>[0]> = {}) {
  const calls: [string, unknown][] = [], navigated: string[] = [];
  let refetched = 0;
  const d = {
    call: async <T>(op: string, params: unknown) => { calls.push([op, params]); return {} as T; },
    waitFor: async () => true,
    refetch: async () => { refetched++; },
    navigate: (hash: string) => { navigated.push(hash); },
    ...over,
  };
  return { d, calls, navigated, refetches: () => refetched };
}
const retry: Action = { label: "Retry on Codex", op: "task.retry", params: { id: "t1", executor: "codex" }, style: "primary" };

test("ui.open navigates without calling the service", async () => {
  const { d, calls, navigated } = deps();
  const runner = createActionRunner(d);
  expect(await runner.run("k", { label: "Review", op: "ui.open", params: { view: "review", id: "t 1" } })).toEqual({ status: "done" });
  expect(calls).toEqual([]);
  expect(navigated).toEqual(["#/review/t%201"]);
  expect(uiHref({ view: "task", id: "t1" })).toBe("#/sessions/t1");
  expect(uiHref({ view: "session", id: "t1" })).toBe("#/sessions/t1");
  expect(uiHref({ view: "settings", section: "executors" })).toBe("#/settings/executors");
  expect(uiHref({ view: "settings" })).toBe("#/settings");
});

test("success waits for the resulting event", async () => {
  let release!: (v: boolean) => void;
  const { d, calls } = deps({ waitFor: () => new Promise<boolean>(r => { release = r; }) });
  const runner = createActionRunner(d);
  const done = runner.run("k", retry, () => true);
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toEqual([["task.retry", { id: "t1", executor: "codex" }]]);
  expect(runner.state("k")).toEqual({ status: "pending" });
  release(true);
  expect(await done).toEqual({ status: "done" });
  expect(runner.state("k")).toEqual({ status: "done" });
});

test("no event within the timeout refetches the snapshot", async () => {
  const { d, refetches } = deps({ waitFor: async () => false });
  const runner = createActionRunner(d);
  expect(await runner.run("k", retry, () => false)).toEqual({ status: "idle" });
  expect(refetches()).toBe(1);
});

test("a conflict means another client acted first and is not a failure", async () => {
  const { d } = deps({ call: async () => { throw new ApiError("conflict", "task changed", undefined, 409); } });
  const runner = createActionRunner(d);
  expect(await runner.run("k", retry)).toEqual({ status: "handled", message: "Already handled elsewhere" });
});

test("other errors keep the service's message and hint", async () => {
  const { d } = deps({ call: async () => { throw new ApiError("invalid_input", "Executor is busy", "Pick another", 400); } });
  expect(await createActionRunner(d).run("k", retry)).toEqual({ status: "error", message: "Executor is busy", hint: "Pick another" });
});

test("an op that returns a job binds the control to it", async () => {
  const { d } = deps({ call: async <T>() => ({ job: { id: "j1" } }) as T });
  expect(await createActionRunner(d).run("k", { label: "Run checks", op: "host.check", params: { alias: "a" } })).toEqual({ status: "job", jobId: "j1" });
});

test("pending is per button", async () => {
  let release!: (v: boolean) => void;
  const { d } = deps({ waitFor: () => new Promise<boolean>(r => { release = r; }) });
  const runner = createActionRunner(d);
  const seen: string[] = [];
  runner.subscribe(() => seen.push(`${runner.state("a").status}/${runner.state("b").status}`));
  const a = runner.run("a", retry, () => true);
  await Promise.resolve();
  expect(runner.state("a").status).toBe("pending");
  expect(runner.state("b").status).toBe("idle");
  release(true);
  await a;
  expect(seen.at(-1)).toBe("done/idle");
});

test("actions that ask first say so", () => {
  const runner = createActionRunner(deps().d);
  expect(runner.needsConfirm({ ...retry, confirm: "Retry on Codex?" })).toBe("Retry on Codex?");
  expect(runner.needsConfirm(retry)).toBeNull();
});

test("storeWaiter resolves on the matching change, or false after the timeout", async () => {
  const { storeWaiter } = await import("../app/src/data/actions");
  const { initialState } = await import("../app/src/data/store");
  let state = initialState();
  const listeners = new Set<() => void>();
  const store = { getState: () => state, subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); } };
  const waiting = storeWaiter(store)(s => s.connected, 1000);
  state = { ...state, connected: true };
  for (const l of listeners) l();
  expect(await waiting).toBe(true);
  expect(listeners.size).toBe(0);
  expect(await storeWaiter(store)(s => s.sessionEnded, 5)).toBe(false);
});

test('takeover row action navigates only after success and preserves conflict reason', async () => {
  const { d, calls, navigated } = deps({call:async <T>()=>({state:'starting'}) as T});
  const runner=createActionRunner(d);
  await runner.run('takeover', {label:'Take over',op:'task.takeover',params:{id:'t 1'}});
  expect(navigated).toEqual(['#/sessions/t%201?takeover=starting']);
  const failed=deps({call:async()=>{throw new ApiError('conflict','No agent session id',undefined,409);}});
  expect(await createActionRunner(failed.d).run('takeover',{label:'Take over',op:'task.takeover',params:{id:'t1'}})).toEqual({status:'error',message:'No agent session id'});
  expect(failed.navigated).toEqual([]);
});
