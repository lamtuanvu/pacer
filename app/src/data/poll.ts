export type SchedulePoll = (run: () => void, delayMs: number) => () => void;
const scheduleTimeout: SchedulePoll = (run, delay) => {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
};
/** Schedule after completion so a slow response never overlaps the next poll. */
export function startPolling(run: () => Promise<void | false>, intervalMs: number, schedule: SchedulePoll = scheduleTimeout): () => void {
  let stopped = false, cancel: (() => void) | undefined;
  const tick = async () => {
    const again = await run();
    if (!stopped && again !== false) cancel = schedule(() => { void tick(); }, intervalMs);
  };
  void tick();
  return () => { stopped = true; cancel?.(); };
}
