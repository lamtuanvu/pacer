import { getWork } from "../dispatch/work";
import { taskTitle } from "../core/short-title";
import { policySummary } from "../plugins/policy";
import { activeAgentSessions } from "../session/agents-state";
import { agentChecksPending } from "../session/agents-checks";
import { appendLabel } from "../tasks/labels";
import { apiTask } from "./read-model/tasks";
import { taskActivity } from "../tasks/activity";
import { autoCleanTask } from "../tasks/cleanup";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";

export type TaskReviewProbeParams = {
  verdict?: unknown;
  expect_state?: unknown;
};

/** Whether native `task.review` must forward to the TypeScript reference handler. */
export function taskReviewProbe(ctx: Ctx, id: string, params: TaskReviewProbeParams) {
  const verdict = typeof params.verdict === "string" ? params.verdict : "";
  if (verdict === "send_back" || verdict === "retry") return { forward: true as const, reason: "verdict" };
  if (getWork(ctx, id)) return { forward: true as const, reason: "managed work" };
  if (agentChecksPending(ctx, id) || activeAgentSessions(ctx).some(s => s.task_id === id)) {
    return { forward: true as const, reason: "agent session" };
  }
  const summary = policySummary(ctx);
  if (summary.mode === "closed" && summary.plugins > 0) return { forward: true as const, reason: "policy" };
  return { forward: false as const };
}

/** Labels, activity and auto-clean after Rust `record_review_verdict`. */
export async function taskReviewAfterStore(
  ctx: Ctx,
  id: string,
  verdict: "accept" | "reject",
  kind: string | undefined,
  note: string | undefined,
) {
  const t = readTask(ctx, id);
  if (!t) throw new Error(`unknown task ${id}`);
  const accepted = verdict === "accept";
  appendLabel(ctx, {
    type: "task_review",
    task_id: id,
    accepted,
    kind: kind ?? t.kind,
    note: note ?? null,
    executor: t.result?.executor ?? null,
  });
  const goal = taskTitle(t);
  taskActivity(ctx, t, "verdict", accepted ? `Accepted “${goal}”` : `Rejected “${goal}”`);
  await autoCleanTask(ctx, id);
  return { task: apiTask(ctx, readTask(ctx, id)!) };
}
