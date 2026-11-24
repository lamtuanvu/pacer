/** Fields needed to recognize a stop whose attempt outcome is already on the record. */
export type RecordedStopPendingView = {
  state: string;
  attempts: readonly unknown[];
  stopPending?: { attempt: number } | null;
  run?: { attempt: number } | null;
};

/**
 * Stuck shape after UI stop: state still "running", stopPending left behind, but the
 * referenced attempt is already in attempts[] and there is no live run for a later attempt.
 * Preparing tasks (no run, intents set, no stopPending) and live runs with an exit file
 * whose outcome is not recorded yet must not match.
 */
export function isRecordedStopPending(task: RecordedStopPendingView): boolean {
  const pending = task.stopPending;
  if (task.state !== "running" || !pending) return false;
  if (pending.attempt > task.attempts.length) return false;
  return !task.run || task.run.attempt <= task.attempts.length;
}
