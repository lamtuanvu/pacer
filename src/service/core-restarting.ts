/** The front-door refusal while the TypeScript core is still starting after a restart. */
export const CORE_RESTARTING = "pacer core is restarting";

export function isCoreRestartingError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes(CORE_RESTARTING);
}

/** Retry only the "core is restarting" refusal, never another error, and only until the deadline (epoch ms). */
export async function retryOnCoreRestart<T>(run: () => Promise<T>, o: { sleep?: (ms: number) => Promise<void>; deadline?: number; pollMs?: number } = {}): Promise<T> {
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = o.deadline ?? Date.now() + 75_000;
  const pollMs = o.pollMs ?? 250;
  for (;;) {
    try { return await run(); }
    catch (error) {
      if (!isCoreRestartingError(error) || Date.now() >= deadline) throw error;
      await sleep(pollMs);
    }
  }
}
