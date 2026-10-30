import { apiTasks } from "../api/read-model/tasks";
import { applyStore } from "../attention/store";
import { deriveTaskItems } from "../core/task-attention";
import type { OutboxEvent } from "../link/envelope";
import { taskData } from "../link/pump";
import { publish, type PublishReport } from "../link/publish";
import { readLatest } from "../link/store";
import { readTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";

/**
 * A task's messages for the human changed: republish the task, whose event carries its unread messages, and its message
 * attention item. The task record and its rev stay as they are; only the read model moves, so every client updates now
 * rather than at the next pump.
 */
export function taskMessageEvents(ctx: Ctx, taskId: string): OutboxEvent[] {
  const record = readTask(ctx, taskId);
  if (!record) return [];
  // Keep what the pump last published, which carries session fields taskData lacks.
  const task: OutboxEvent = { type: "task", data: readLatest(ctx).tasks.find(t => t.id === taskId) ?? taskData(record) };
  // The task's retry decides whether its items are superseded.
  const retry = record.retriedBy ? readTask(ctx, record.retriedBy) : null;
  const rows = apiTasks(ctx, [record, ...(retry ? [retry] : [])] as TaskRecord[]).map(t => ({ ...t, title: t.fullTitle ?? t.title }));
  const id = `message:${taskId}`;
  // Read only: the pump owns the attention store and drops entries this one task does not raise.
  const item = applyStore({ ...ctx, readOnly: true }, deriveTaskItems({ now: ctx.now, tasks: rows, executors: [], accounts: [], planner: null,
    setup: { complete: true, open: 0, items: [] }, update: null, retryTarget: () => null }).filter(i => i.id === id))[0];
  return [task, { type: "entity", data: item ? { kind: "attention", id, value: item } : { kind: "attention", id, removed: true } }];
}

/** The events are built under the link lock, so concurrent changes publish in the order they read the store. */
export function publishTaskMessages(ctx: Ctx, taskIds: (string | null)[], extra: OutboxEvent[] = []): Promise<PublishReport> {
  return publish(ctx, () => [...extra, ...[...new Set(taskIds)].flatMap(id => id ? taskMessageEvents(ctx, id) : [])]);
}
