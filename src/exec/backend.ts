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

const loggedDirect = (line: string): Backend => ({
  ...directBackend,
  runAttempt: async (ctx, cfg, task, onSpawn) => {
    const out = await directBackend.runAttempt(ctx, cfg, task, onSpawn);
    appendFileSync(out.attempt.log, `direct backend: ${line}\n`);
    return out;
  },
});

/**
 * Orca hosts interactive runs; headless runs, connections and unsupported agent TUIs require direct execution.
 * Without Orca, interactive runs use the builtin PTY of the direct backend.
 */
export async function selectBackend(ctx: Ctx, s: Strategy, extras: Backend[] = defaultBackends(), runnerId?: string): Promise<Backend> {
  const runner = runnerId ? resolveRunner(s, runnerId) : undefined;
  // The same resolution as the attempt (runAttempt), including strict enforcement's headless rule.
  const launch = runner ? launchModeFor({id: runner.id, via: runner.agent === "opencode" ? "opencode" : null, session: runner.session}, validateExecution(s.execution),
    {managed: ctx.env.PACER_ENFORCEMENT_MODE === "strict"}) : undefined;
  const account = runner ? s.accounts[runner.account] : undefined;
  const wantsOrca = ctx.env.PACER_BACKEND === "orca" || (!ctx.env.PACER_BACKEND && s.execution?.backend === "orca");
  if (wantsOrca && runner) {
    if (account?.connection) return loggedDirect("connection endpoint (credentials stay in the OpenCode child environment)");
    if (!["claude-code", "codex"].includes(runner.agent)) return loggedDirect(`unsupported Orca terminal agent (${runner.agent})`);
    if (ctx.env.PACER_ENFORCEMENT_MODE === "strict") return loggedDirect("strict delegation enforcement (certified for direct launches only)");
    if (launch?.mode === "headless") return loggedDirect(`headless launch mode (Orca hosts interactive runs only${launch.fallback ? `; ${launch.fallback}` : ""})`);
  }
  if (wantsOrca) {
    const orca = extras.find(b => b.id === "orca");
    try { return orca && await orca.available(ctx, s) ? orca : directBackend; }
    catch { return directBackend; }
  }
  if (launch?.mode === "interactive") return directBackend;
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
