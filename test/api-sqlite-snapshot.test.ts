import { expect, spyOn, test } from "bun:test";
import { liveSnapshot } from "../src/api/events";
import * as store from "../src/tasks/store";
import { fakeCtx } from "./helpers";

const input = { brief: { goal: "snapshot", repo: "/tmp/repo" }, kind: null, requestedExecutor: null, timeoutS: 60 };
const status = async (ctx: ReturnType<typeof fakeCtx>) => ({ generatedAt: ctx.now, strategy: "default", planner: "codex", mode: "normal", disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } }) as never;

test("snapshots cache indexed selections, expire old records, and refresh on local and external commits", async () => {
  const ctx = { ...fakeCtx(), readOnly: true };
  const old = store.createTask({ ...ctx, now: ctx.now - 90000 }, input);
  store.updateTask({ ...ctx, now: ctx.now - 90000 }, old.id, t => { t.state = "done"; });
  const recent = store.createTask({ ...ctx, now: ctx.now - 86390 }, input);
  store.updateTask({ ...ctx, now: ctx.now - 86390 }, recent.id, t => { t.state = "done"; });
  const active = store.createTask(ctx, input);
  store.updateTask(ctx, active.id, t => { t.queue = { reason: "paused", since: ctx.now, position: 1 }; });
  const query = spyOn(store, "listTasksWhere");
  const health = spyOn(globalThis, "fetch").mockRejectedValue(Error("isolated"));
  try {
    const first = await liveSnapshot(ctx, { status });
    expect(first.snapshot.tasks.map(t => t.id)).toContain(recent.id);
    expect(first.snapshot.tasks.map(t => t.id)).not.toContain(old.id);
    const count = () => query.mock.calls.filter(([, filter]) => filter?.states || filter?.updatedSince !== undefined).length;
    const calls = count();
    expect(calls).toBe(2);
    await liveSnapshot(ctx, { status });
    expect(count()).toBe(calls);
    const later = await liveSnapshot({ ...ctx, now: ctx.now + 20 }, { status });
    expect(count()).toBe(calls);
    expect(later.snapshot.tasks.map(t => t.id)).not.toContain(recent.id);
    store.updateTask(ctx, active.id, t => { t.title = "local change"; });
    expect((await liveSnapshot(ctx, { status })).snapshot.tasks.find(t => t.id === active.id)?.title).toBe("local change");
    const script = `import { updateTask } from ${JSON.stringify(new URL("../src/tasks/store.ts", import.meta.url).pathname)}; updateTask(JSON.parse(process.argv[1]),process.argv[2],t=>{t.title="external change";});`;
    const child = Bun.spawn([process.execPath, "-e", script, JSON.stringify({ pacerHome: ctx.pacerHome, now: ctx.now }), active.id], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect((await liveSnapshot(ctx, { status })).snapshot.tasks.find(t => t.id === active.id)?.title).toBe("external change");
  } finally { query.mockRestore(); health.mockRestore(); }
});

test("cached active records still detect runners that never started as time passes", async () => {
  const ctx = { ...fakeCtx(), readOnly: true }, task = store.createTask(ctx, input);
  const health = spyOn(globalThis, "fetch").mockRejectedValue(Error("isolated"));
  try {
    expect((await liveSnapshot(ctx, { status })).snapshot.tasks.find(t => t.id === task.id)?.state).toBe("queued");
    expect((await liveSnapshot({ ...ctx, now: ctx.now + 601 }, { status })).snapshot.tasks.find(t => t.id === task.id)?.state).toBe("failed");
  } finally { health.mockRestore(); }
});
