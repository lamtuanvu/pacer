import { appendFileSync } from "node:fs";
import { resolveRunner } from "../config/runner-id";
import type { ProviderCfg, Strategy } from "../config/strategy";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { defaultBackends } from "./backends-extra";
import { type AttemptOutcome, runAttempt } from "./direct";
import { launchModeFor } from "./launch";
import { validateExecution } from "../config/execution";

export interface Backend {
  id: string;
  available(ctx: Ctx, s: Strategy): Promise<boolean>;
  runAttempt(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn?: (pid: number) => void): Promise<AttemptOutcome>;
}

export const directBackend: Backend = { id: "direct", available: async () => true, runAttempt };

/** Whether the backend with this id reports itself available; unknown ids are not. */
export async function backendAvailable(ctx: Ctx, s: Strategy, id: string, extras: Backend[] = defaultBackends()): Promise<boolean> {
  const b = [...extras, directBackend].find((b) => b.id === id);
  return b ? b.available(ctx, s) : false;
}

/** Connections and unsupported agent TUIs require direct execution. */
export async function selectBackend(ctx: Ctx, s: Strategy, extras: Backend[] = defaultBackends(), runnerId?: string): Promise<Backend> {
  const runner = runnerId ? resolveRunner(s, runnerId) : undefined;
  // The same resolution as the attempt (runAttempt), including strict enforcement's headless rule.
  if (runner && launchModeFor({id: runner.id, via: runner.agent === "opencode" ? "opencode" : null, session: runner.session}, validateExecution(s.execution),
    {managed: ctx.env.PACER_ENFORCEMENT_MODE === "strict"}).mode === "interactive") return directBackend;
  const account = runner ? s.accounts[runner.account] : undefined;
  const wantsOrca = ctx.env.PACER_BACKEND === "orca" || (!ctx.env.PACER_BACKEND && s.execution?.backend === "orca");
  if (wantsOrca && (account?.connection || (runner && !["claude-code", "codex"].includes(runner.agent)))) {
    return {
      ...directBackend,
      runAttempt: async (ctx, cfg, task, onSpawn) => {
        const out = await directBackend.runAttempt(ctx, cfg, task, onSpawn);
        appendFileSync(out.attempt.log, account?.connection
          ? "direct backend: connection endpoint (credentials stay in the OpenCode child environment)\n"
          : `direct backend: unsupported Orca terminal agent (${runner?.agent})\n`);
        return out;
      },
    };
  }
  const forced = ctx.env.PACER_BACKEND;
  if (forced === "orca") {
    const orca = extras.find(b => b.id === "orca");
    try { return orca && await orca.available(ctx, s) ? orca : directBackend; }
    catch { return directBackend; }
  }
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
