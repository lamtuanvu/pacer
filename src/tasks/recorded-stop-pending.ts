import { pidAlive } from "../link/pid";

/** Fields needed to recognize a stop whose attempt outcome is already on the record. */
export type RecordedStopPendingView = {
  state: string;
  attempts: readonly unknown[];
  stopPending?: { attempt: number } | null;
  run?: { attempt: number } | null;
  runnerPid?: number;
  childPid?: number;
};

/** Same shape as the local `alive` helper in api.ts: undefined/0 is not alive. */
export type PidLiveness = (pid: number | undefined) => boolean;

const defaultAlive: PidLiveness = pid => !!pid && pidAlive(pid);

/**
 * Stuck shape after UI stop: state still "running", stopPending left behind, but the
 * referenced attempt is already in attempts[] and there is no live run for a later attempt.
 * Preparing tasks (no run, intents set, no stopPending) and live runs with an exit file
 * whose outcome is not recorded yet must not match.
 * Only settled/skipped when runnerPid and childPid are both not alive — a runner that
 * has recorded attempt N but is still finishing (or preparing N+1) must stay visible.
 */
export function isRecordedStopPending(
  task: RecordedStopPendingView,
  alive: PidLiveness = defaultAlive,
): boolean {
  const pending = task.stopPending;
  if (task.state !== "running" || !pending) return false;
  if (pending.attempt > task.attempts.length) return false;
  if (task.run && task.run.attempt > task.attempts.length) return false;
  if (alive(task.runnerPid) || alive(task.childPid)) return false;
  return true;
}
