import { withLockSync } from "../core/lock";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import type { Brief, TaskRecord } from "./types";

const ID_RE = /^t-\d{8}-\d{6}-[0-9a-f]{4}$/;

export const tasksDir = (ctx: Ctx) => join(ctx.pacerHome, "tasks");
const taskFile = (ctx: Ctx, id: string) => join(tasksDir(ctx), `${id}.json`);

export function newTaskId(nowS: number): string {
  const d = new Date(nowS * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `t-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function isTaskId(id: string): boolean {
  return ID_RE.test(id);
}

export function createTask(
  ctx: Ctx, input: { title?: string; brief: Brief; kind: string | null; requestedExecutor: string | null; timeoutS: number },
): TaskRecord {
  // Ids carry only two random bytes per second; never reuse one already on disk.
  let id = newTaskId(ctx.now);
  for (let i = 0; i < 64 && existsSync(taskFile(ctx, id)); i++) id = newTaskId(ctx.now);
  const task: TaskRecord = { rev: 1, id, createdAt: ctx.now, ...input, state: "queued", attempts: [] };
  writeJsonAtomic(taskFile(ctx, task.id), task);
  return task;
}

export function readTask(ctx: Ctx, id: string): TaskRecord | null {
  const task = isTaskId(id) ? readJson<TaskRecord>(taskFile(ctx, id)) : null;
  if (task) task.rev ??= 1;
  return task;
}

// Only synchronous callbacks may run here: nested updates share the operation's
// lock, and no other callback in this process can interleave while it is held.
const heldTaskLocks = new Set<string>();
export function withTaskLock<T>(ctx: Ctx, id: string, action: () => T): T {
  if (!isTaskId(id)) return action(); // Preserve each caller's unknown-task handling.
  const key = taskFile(ctx, id);
  if (heldTaskLocks.has(key)) return action();
  return withLockSync(ctx, `task-${id}`, () => {
    heldTaskLocks.add(key);
    try { return action(); }
    finally { heldTaskLocks.delete(key); }
  });
}

export function updateTask(ctx: Ctx, id: string, mutate: (t: TaskRecord) => void): TaskRecord {
  return withTaskLock(ctx, id, () => {
    const t = readTask(ctx, id);
    if (!t) throw new Error(`unknown task ${id}`);
    const rev = t.rev;
    mutate(t);
    t.rev = rev + 1;
    writeJsonAtomic(taskFile(ctx, id), t);
    return t;
  });
}

/** Newest first. */
export function listTasks(ctx: Ctx, limit = 20): TaskRecord[] {
  const dir = tasksDir(ctx);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter(isTaskId)
    .sort()
    .reverse()
    .slice(0, limit)
    .map((id) => readTask(ctx, id))
    .filter((t): t is TaskRecord => t !== null);
}
