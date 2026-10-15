import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ApiError, InProcessClient } from "../src/api/client";
import { liveSnapshot } from "../src/api/events";
import { publish } from "../src/link/publish";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

async function ctxWithStrategy() {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  return ctx;
}
const fakeStatus = (generatedAt: number) => async () => ({ generatedAt, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } }) as never;

test("liveSnapshot recomputes only stale budgets and reports live task state", async () => {
  const ctx = await ctxWithStrategy();
  let calls = 0;
  const status = async (c: typeof ctx) => { calls++; return fakeStatus(c.now)(); };
  const a = await liveSnapshot(ctx, { status });
  expect(calls).toBe(1);
  expect(a.snapshot.budget?.generatedAt).toBe(ctx.now);
  await publish(ctx, [{ v: 1, type: "budget", data: a.snapshot.budget! }], { bridge: false, channel: false });
  await liveSnapshot({ ...ctx, now: ctx.now + 30 }, { status });
  expect(calls).toBe(1);
  await liveSnapshot({ ...ctx, now: ctx.now + 120 }, { status });
  expect(calls).toBe(2);
  const t = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, (x) => { x.state = "running"; x.runnerPid = 2 ** 22 + 7; x.attemptStartedAt = ctx.now; x.attempts = []; });
  const b = await liveSnapshot({ ...ctx, now: ctx.now + 30 }, { status });
  expect(b.snapshot.tasks.find((x) => x.id === t.id)?.state).toBe("failed");
});

test("InProcessClient calls ops, maps errors and streams events", async () => {
  const ctx = await ctxWithStrategy();
  const client = new InProcessClient(() => ctx, { pollMs: 20, status: fakeStatus(ctx.now) });
  expect((await client.hello()).protocol).toBe("2.0.0");
  const err = await client.call("task.get", { id: "missing" }).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  if (!(err instanceof ApiError)) throw new Error("expected an ApiError");
  expect(err.code).toBe("unknown_task");
  const seen: string[] = [];
  const stop = client.subscribe(0, (e) => seen.push(e.type));
  await publish(ctx, [{ v: 1, type: "alert", data: { key: "k", level: "info", title: "t", body: "", at: ctx.now } }], { bridge: false, channel: false });
  const end = Date.now() + 2000; while (!seen.length && Date.now() < end) await Bun.sleep(10);
  stop(); client.close();
  expect(seen).toEqual(["alert"]);
});
