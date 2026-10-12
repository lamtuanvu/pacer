import type { ProviderCfg, Strategy } from "../config/strategy";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { EXTRA_BACKENDS } from "./backends-extra";
import { type AttemptOutcome, runAttempt } from "./direct";

export interface Backend {
  id: string;
  available(ctx: Ctx, s: Strategy): Promise<boolean>;
  runAttempt(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn?: (pid: number) => void): Promise<AttemptOutcome>;
}

export const directBackend: Backend = { id: "direct", available: async () => true, runAttempt };

/** PACER_BACKEND forces a backend id (unknown -> direct); otherwise the first available extra backend, else direct. */
export async function selectBackend(ctx: Ctx, s: Strategy, extras: Backend[] = EXTRA_BACKENDS): Promise<Backend> {
  const forced = ctx.env.PACER_BACKEND;
  if (forced) return [...extras, directBackend].find((b) => b.id === forced) ?? directBackend;
  for (const b of extras) {
    try {
      if (await b.available(ctx, s)) return b;
    } catch {
      // an unavailable backend never blocks execution
    }
  }
  return directBackend;
}
