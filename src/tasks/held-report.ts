import { heldOpenForHuman } from "../messaging/participants";
import { readReport } from "../session/reports";
import type { Ctx } from "../types";
import type { TaskRecord, TaskResult } from "./types";

/**
 * A user stop can leave state "running" with stopPending on a plugin-owned run until the runner
 * reconciles it. Deadlines are not user stops.
 */
export function userStopped(t: TaskRecord): boolean {
  return t.state === "stopped" || (!!t.executorProvider && !!t.stopPending && t.stopPending.reason !== "deadline");
}

/**
 * A held interactive root keeps its terminal after `pacer report done|failed`. When the user ends
 * it, honour the last report so the outcome stays available for review; without a report, the
 * recorded stop stands. Null means "no report to preserve".
 */
export function heldSettlement(ctx: Ctx, t: TaskRecord, result: TaskResult): TaskResult | null {
  if (!userStopped(t) || !heldOpenForHuman(ctx, t) || !t.run?.dir) return null;
  const report = readReport(t.run.dir);
  if (!report || !["done", "failed"].includes(report.status)) return null;
  return { ...result, status: report.status === "done" ? "done" : "failed", report: report.summary };
}
