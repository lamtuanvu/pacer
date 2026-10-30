import { appendActivity, type ActivityEntry } from "../activity/log";
import { repoFor } from "../core/repos";
import type { Ctx } from "../types";
import type { TaskRecord } from "./types";

export function taskActivity(ctx: Ctx, task: TaskRecord, kind: ActivityEntry["kind"], text: string): void {
  const executor = task.result?.executor ?? task.executor ?? task.attempts.at(-1)?.executor ?? task.requestedExecutor;
  appendActivity(ctx, { kind, level: "info", text, repo: (task.repo ?? repoFor(ctx, task.brief.repo)).key, taskId: task.id,
    ...(executor ? { executor } : {}), ...(task.run?.host ? { host: task.run.host } : {}) });
}
