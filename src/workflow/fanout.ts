// Which fan-out attempt a step row belongs to, and which row speaks for a step.
// A retried branch has a later attempt number than the fan-out it belongs to; its
// trigger records that fan-out. Pure, so clients share it with the engine.

export type FanoutRow = { attempt: number; branch?: string; trigger?: string };

/** The fan-out attempt a row belongs to: its own, or for a retried branch the one
 *  whose branch it replaces. */
export function fanoutAttempt(row: FanoutRow): number {
  const retry = /^retry:(\d+):/.exec(row.trigger ?? "");
  return retry ? Number(retry[1]) : row.attempt;
}

/** The rows of a step's latest fan-out attempt: the newest row of each branch, and
 *  the join row when there is one. */
export function latestFanoutRows<T extends FanoutRow>(rows: T[]): T[] {
  const attempt = Math.max(0, ...rows.map(fanoutAttempt));
  const byBranch = new Map<string, T>();
  for (const row of rows) {
    if (fanoutAttempt(row) !== attempt) continue;
    const prior = byBranch.get(row.branch ?? "");
    if (!prior || row.attempt >= prior.attempt) byBranch.set(row.branch ?? "", row);
  }
  return [...byBranch.values()];
}

/** Whether `row`, rather than `prior`, carries a step's result: a later fan-out
 *  attempt wins, then the join over any branch, then the later attempt. */
export function speaksFor(row: FanoutRow, prior: FanoutRow): boolean {
  const [a, b] = [fanoutAttempt(row), fanoutAttempt(prior)];
  if (a !== b) return a > b;
  const [joined, priorJoined] = [row.branch === undefined, prior.branch === undefined];
  if (joined !== priorJoined) return joined;
  return row.attempt >= prior.attempt;
}
