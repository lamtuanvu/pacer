import { appendFileSync } from "node:fs";
import { resolveRunner } from "../config/runner-id";
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

/** Non-default account folders require direct execution; otherwise honor the backend override or availability. */
export async function selectBackend(ctx: Ctx, s: Strategy, extras: Backend[] = EXTRA_BACKENDS, runnerId?: string): Promise<Backend> {
  const runner = runnerId ? resolveRunner(s, runnerId) : undefined;
  const account = runner ? s.accounts[runner.account] : undefined;
  if (account?.source === "pacer" || account?.source === "orca") {
    return {
      ...directBackend,
      runAttempt: async (ctx, cfg, task, onSpawn) => {
        const out = await directBackend.runAttempt(ctx, cfg, task, onSpawn);
        appendFileSync(out.attempt.log, "direct backend: non-default account (Orca launch can't pre-approve folder trust)\n");
        return out;
      },
    };
  }
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
