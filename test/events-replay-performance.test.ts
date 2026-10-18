import { expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventsSince } from "../src/api/events";
import { taskData } from "../src/link/pump";
import { appendOutbox, OUTBOX_KEEP } from "../src/link/store";
import * as store from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { fakeCtx, tmpDir } from "./helpers";

// A home shaped like a long-lived install: hundreds of task records and a full outbox
// of task events. Clients replay from cursor 0 when the service restarts.
function largeHome(tasks = 400) {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "tasks"), { recursive: true });
  const repo = tmpDir();
  const records: TaskRecord[] = [];
  for (let i = 0; i < tasks; i++) {
    const t: TaskRecord = {
      id: `t-20261010-1900${String(Math.floor(i / 60)).padStart(2, "0")}-${String(i).padStart(4, "0")}`,
      rev: 1, createdAt: ctx.now - i * 60, brief: { goal: `Task number ${i}. More detail`, repo },
      kind: i % 2 ? "tests" : null, requestedExecutor: null, timeoutS: 60, state: i % 3 ? "done" : "running", attempts: [],
    };
    writeFileSync(join(ctx.pacerHome, "tasks", `${t.id}.json`), JSON.stringify(t));
    records.push(t);
  }
  const entries = Array.from({ length: OUTBOX_KEEP }, (_, i) => ({
    seq: i + 1, at: ctx.now, envelope: { type: "task" as const, data: taskData(records[i % records.length]) },
  }));
  appendOutbox(ctx, entries);
  return { ctx, records };
}

test("replaying the whole outbox lists task files once, not once per event", () => {
  const { ctx } = largeHome();
  const lists = spyOn(store, "listTasks");
  try {
    for (const protocol of [2, 3] as const) {
      lists.mockClear();
      const started = performance.now();
      const { events } = eventsSince(ctx, 0, protocol);
      const ms = performance.now() - started;
      expect(events).toHaveLength(OUTBOX_KEEP);
      expect(lists.mock.calls.length).toBeLessThanOrEqual(1);
      // Before the fix this took tens of seconds on a home this size; it must stay interactive.
      expect(ms).toBeLessThan(1000);
    }
  } finally {
    lists.mockRestore();
  }
});

test("replayed task events still carry repo, kind and title", () => {
  const { ctx, records } = largeHome(20);
  const { events } = eventsSince(ctx, 0, 2);
  const first = events.find(e => e.type === "task" && (e.data as { id: string }).id === records[1].id)!.data as Record<string, unknown>;
  expect(first).toMatchObject({ id: records[1].id, kind: "tests", title: "Task number 1", host: null });
  expect((first.repo as { path: string }).path).toBeString();
});

test("a snapshot during status warm-up answers at once and says it is starting", async () => {
  const { liveSnapshot } = await import("../src/api/events");
  const { ctx } = largeHome(20);
  const warming = await liveSnapshot(ctx, { status: async () => { throw new Error("status is warming up"); } });
  expect(warming.snapshot.service.starting).toBe(true);
  const ready = await liveSnapshot({ ...ctx, now: ctx.now + 1 }, {
    status: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } }),
  });
  expect(ready.snapshot.service.starting).toBeUndefined();
});
