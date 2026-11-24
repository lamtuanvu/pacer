// "Since you last looked": person opens a run → optional returned wake-up;
// orchestrator writes a capped summary via run.decide { kind: "summary" }.
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { getRun, updateRun, type RunRow } from "./store";
import { enqueueWakeup, openWakeups } from "./wakeups";

/** UTF-8 byte cap for the stored since-you-last-looked summary. */
export const SUMMARY_MAX_BYTES = 4 * 1024;

export function capSummaryText(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= SUMMARY_MAX_BYTES) return text;
  // Truncate on a code-point boundary so the result is valid UTF-8.
  let end = SUMMARY_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** Stamp used for since-you-last-looked (falls back to updatedAt for older rows). */
export function meaningfulStamp(run: Pick<RunRow, "meaningfulAt" | "updatedAt">): number {
  return run.meaningfulAt ?? run.updatedAt;
}

/** True when the person returning should get a returned wake-up. */
export function needsReturnedSummary(run: RunRow): boolean {
  const lastSeen = run.lastSeenAt ?? 0;
  const stamp = meaningfulStamp(run);
  if (!(stamp > lastSeen)) return false;
  if (run.summaryAt != null && run.summaryAt >= stamp) return false;
  return true;
}

/**
 * Person opened the run: stamp last_seen_at; enqueue a returned wake-up when
 * something changed since last look and no fresher summary exists.
 * Returns whether a wake-up was written (or already open for this change).
 */
export function markRunSeen(ctx: Ctx, runId: string): { run: RunRow; woke: boolean } {
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  // Terminal runs: record the look, never enqueue a wake-up.
  if (run.status === "done" || run.status === "failed" || run.status === "stopped") {
    const updated = updateRun(ctx, run.id, run.rev, { lastSeenAt: ctx.now });
    return { run: updated, woke: false };
  }
  const stamp = meaningfulStamp(run);
  const wake = needsReturnedSummary(run);
  if (wake) {
    enqueueWakeup(ctx, {
      runId: run.id,
      cause: "returned",
      ref: `seen:${stamp}`,
      byPerson: true,
    });
  }
  const updated = updateRun(ctx, run.id, run.rev, { lastSeenAt: ctx.now });
  const open = openWakeups(ctx, run.id).some(
    w => w.cause === "returned" && w.ref === `seen:${stamp}`,
  );
  return { run: updated, woke: wake || open };
}

/** Store the orchestrator's since-you-last-looked summary (≤ 4 KiB). Retries on rev conflict. */
export function storeRunSummary(ctx: Ctx, runId: string, expectRev: number, text: string): RunRow {
  const capped = capSummaryText(text.trim());
  if (!capped) throw new CoreError("invalid_input", "Summary body is empty");
  const patch = { summary: capped, summaryAt: ctx.now };
  try {
    return updateRun(ctx, runId, expectRev, patch);
  } catch (e) {
    if (!(e instanceof CoreError) || e.code !== "conflict") throw e;
    const live = getRun(ctx, runId);
    if (!live) throw new CoreError("not_found", `unknown run ${runId}`);
    return updateRun(ctx, runId, live.rev, patch);
  }
}
