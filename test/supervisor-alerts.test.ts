import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { progressPoller } from "../src/exec/direct";
import * as link from "../src/link/publish";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { RunState } from "../src/supervisor/run";
import { fakeCtx, tmpDir } from "./helpers";

const published: { key: string; title: string }[] = [];
const spy = spyOn(link, "publish").mockImplementation(async (_ctx, events) => {
  for (const e of events as { type: string; data: { key: string; title: string } }[]) if (e.type === "alert") published.push({ key: e.data.key, title: e.data.title });
  return { delivered: 0 } as never;
});
afterEach(() => { published.length = 0; });
afterAll(() => spy.mockRestore());

function task(startedAt = Date.now() / 1000) {
  const ctx = fakeCtx({ now: Date.now() / 1000 }), repo = tmpDir();
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: "cursor", timeoutS: 3600 });
  const run = { dir: join(ctx.pacerHome, "runs", t.id, "1"), attempt: 1, executor: "cursor", startedAt, mode: "current" as const, workdir: repo, logFile: join(ctx.pacerHome, "tasks", `${t.id}.log`) };
  return { ctx, t: updateTask(ctx, t.id, x => { x.state = "running"; x.run = run; }) };
}
const state = (status: "needs-input" | "running"): RunState => ({ interactive: true, report: { status, summary: "Which branch?", at: Date.now() / 1000 }, pid: 1, startedAt: null, exit: null, alive: true, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: Date.now() / 1000 });

test("a replacement runner neither repeats nor orphans an open needs-input alert", async () => {
  const { ctx, t } = task();
  await progressPoller(ctx, t, t.run!)(state("needs-input"));
  expect(published.filter(p => p.title.startsWith("Task needs input"))).toHaveLength(1);
  const key = readTask(ctx, t.id)!.run!.waitKey!;
  expect(key).toStartWith(`needs-input-${t.id}-`);
  const replacement = readTask(ctx, t.id)!;
  const poll = progressPoller(ctx, replacement, replacement.run!);
  await poll(state("needs-input"));
  expect(published.filter(p => p.title.startsWith("Task needs input"))).toHaveLength(1);
  await poll(state("running"));
  expect(published.at(-1)).toEqual({ key, title: "Task input resumed" });
  expect(readTask(ctx, t.id)!.run!.waitKey).toBeUndefined();
});

test("the idle alert is sent once per attempt, not once per runner", async () => {
  const { ctx, t } = task(Date.now() / 1000 - 7200);
  const idle: RunState = { pid: 1, startedAt: null, exit: null, alive: true, stdoutBytes: 10, stderrBytes: 0, lastOutputAt: Date.now() / 1000 - 7200 };
  await progressPoller(ctx, t, t.run!)(idle);
  expect(published.filter(p => p.title === "Task is idle")).toHaveLength(1);
  expect(typeof readTask(ctx, t.id)!.run!.idleAlertedAt).toBe("number");
  const replacement = readTask(ctx, t.id)!;
  await progressPoller(ctx, replacement, replacement.run!)(idle);
  expect(published.filter(p => p.title === "Task is idle")).toHaveLength(1);
});
