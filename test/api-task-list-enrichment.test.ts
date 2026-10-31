import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { writeJsonAtomic } from "../src/fsutil";
import * as store from "../src/tasks/store";
import * as repos from "../src/core/repos";
import * as messages from "../src/messaging/store";
import { callOp } from "../src/api/ops";
import type { ApiTask } from "../src/api/read-model/types";
import { fakeCtx, tmpDir } from "./helpers";

test("task.list batches repository scans without changing legacy labels, order, cursors or metadata", async () => {
  const ctx = fakeCtx();
  const registered = join(tmpDir(), "same"), other = join(tmpDir(), "same");
  writeJsonAtomic(join(ctx.pacerHome, "state", "repos.json"), {
    [registered]: { key: "local:registered", path: registered, lastUsed: ctx.now },
  });
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const task = store.createTask({ ...ctx, now: ctx.now + i }, { brief: { goal: `Task ${i}`, repo: other }, kind: null, requestedExecutor: null, timeoutS: 60 });
    store.updateTask(ctx, task.id, t => {
      t.source = "cli";
      if (i % 2 === 0) t.repo = { key: "local:unregistered", path: other, label: "old label" };
    });
    ids.unshift(task.id);
  }
  const scans = spyOn(store, "listActiveAndRecentTasks");
  try {
    for (const limit of [1, 10, 20]) {
      scans.mockClear();
      const page = await callOp(ctx, "task.list", { limit }) as { tasks: ApiTask[]; next: string | null };
      expect(page.tasks.map(t => t.id)).toEqual(ids.slice(0, limit));
      expect(page.next).toBe(ids[limit - 1]!);
      expect(page.tasks.every(t => t.source === "cli")).toBe(true);
      expect(page.tasks.every(t => t.repo.label === `same (${t.repo.key})`)).toBe(true);
      // Real task-backed repository enumeration must stay constant as the page grows.
      expect(scans.mock.calls.length).toBeLessThanOrEqual(1);
    }
    const page = await callOp(ctx, "task.list", { limit: 20, before: ids[19] }) as { tasks: ApiTask[]; next: string | null };
    expect(page.tasks.map(t => t.id)).toEqual(ids.slice(20));
    expect(page.next).toBeNull();
  } finally { scans.mockRestore(); }
});

test("an exhausted task.list page skips repository and unread enrichment", async () => {
  const ctx = fakeCtx();
  const task = store.createTask(ctx, {brief: {goal: "Last row", repo: tmpDir()}, kind: null, requestedExecutor: null, timeoutS: 60});
  const scans = spyOn(store, "listActiveAndRecentTasks");
  const registry = spyOn(repos, "listRepos");
  const unread = spyOn(messages, "unreadCounts");
  try {
    expect(await callOp(ctx, "task.list", {limit: 1, before: task.id})).toEqual({tasks: [], next: null});
    expect(registry).not.toHaveBeenCalled();
    expect(scans).not.toHaveBeenCalled();
    expect(unread).not.toHaveBeenCalled();
  } finally { scans.mockRestore(); registry.mockRestore(); unread.mockRestore(); }
});
