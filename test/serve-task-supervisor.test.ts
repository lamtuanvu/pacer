import { expect, spyOn, test } from "bun:test";
import * as tasks from "../src/tasks/api";
import { startServer } from "../src/serve/http";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

test("service supervision runs every five seconds, is single in-flight, and leaves health responsive", async () => {
  const ctx = fakeCtx({which: () => null});
  let tick!: () => void, release!: () => void;
  const interval = globalThis.setInterval;
  const timers = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
    if (ms === 5000) tick = fn;
    return interval(fn, ms);
  }) as typeof setInterval);
  const supervise = spyOn(tasks, "superviseTasks").mockImplementation(() => new Promise<void>(resolve => {release = resolve;}));
  const server = startServer(() => ctx, {port: 0, listener: false, pumpMs: 0});
  timers.mockRestore();
  try {
    tick(); tick();
    expect(supervise).toHaveBeenCalledTimes(1);
    const response = await fetch(`http://127.0.0.1:${server.port}/health`, {signal: AbortSignal.timeout(500)});
    expect(response.status).toBe(200);
    release(); await Bun.sleep(0);
    tick();
    expect(supervise).toHaveBeenCalledTimes(2);
    server.stop(); release(); await Bun.sleep(0);
    tick();
    expect(supervise).toHaveBeenCalledTimes(2);
  } finally {server.stop(); supervise.mockRestore();}
});

test("service tick settles dead tasks without a status request and stops on shutdown", async () => {
  const ctx = fakeCtx({which: () => null});
  const task = createTask(ctx, {brief: {goal: "g", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 60});
  updateTask(ctx, task.id, t => {t.state = "running"; t.attemptStartedAt = ctx.now;});
  let tick!: () => void;
  const interval = globalThis.setInterval;
  const timers = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
    if (ms === 5000) tick = fn;
    return interval(fn, ms);
  }) as typeof setInterval);
  const server = startServer(() => ctx, {port: 0, listener: false, pumpMs: 0});
  timers.mockRestore();
  try {
    tick();
    const deadline = Date.now() + 1000;
    while (readTask(ctx,task.id)?.state === "running" && Date.now() < deadline) await Bun.sleep(10);
    expect(readTask(ctx,task.id)?.state).toBe("failed");
  } finally {server.stop();}
});
