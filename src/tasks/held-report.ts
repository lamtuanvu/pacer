import { heldOpenForHuman } from "../messaging/participants";
import { readHeldReport } from "../session/reports";
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
 * it, honour that report so the outcome stays available for review; without a report, the
 * recorded stop stands. Null means "no report to preserve".
 *
 * The caller passes the stop decision it captured before clearing stopPending: re-checking the
 * task here would miss a plugin-owned stop whose state is still "running". The report is read from
 * its own per-attempt record, which native hooks cannot overwrite.
 */
export function heldSettlement(ctx: Ctx, t: TaskRecord, result: TaskResult, stoppedByUser = userStopped(t)): TaskResult | null {
  if (!stoppedByUser || !heldOpenForHuman(ctx, t) || !t.run?.dir) return null;
  const report = readHeldReport(t.run.dir, t.run.attempt);
  if (!report || !["done", "failed"].includes(report.status)) return null;
  return { ...result, status: report.status === "done" ? "done" : "failed", report: report.summary };
}
