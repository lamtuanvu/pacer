import type { Ctx } from "../types";
import type { RunnerCfg } from "../config/accounts";
import { loadStrategy } from "../config/strategy";
import { resolveRunner } from "../config/runner-id";
import { readManifest } from "../install/manifest";
import { reconcileIntegrations } from "../install/reconcile";
import { CoreError } from "./errors";

export const refreshConnectedIntegrations = (ctx: Ctx) => reconcileIntegrations(ctx);

/** Only previously connected local accounts require readiness. */
export async function ensureRunnerIntegration(ctx: Ctx, runner: RunnerCfg): Promise<void> {
  if (runner.host) return;
  const records = readManifest(ctx).planners;
  let key = `${runner.agent}#${runner.account}`;
  if (!records[key]) {
    const defaultRecord = records[runner.agent];
    if (!defaultRecord) return;
    if (defaultRecord.account && defaultRecord.account !== runner.account) return;
    if (!defaultRecord.account) {
      // Legacy default records can precede strategy initialization.
      try { if (loadStrategy(ctx).accounts[runner.account]?.source !== "default") return; }
      catch { /* The recorded default integration still requires a freshness check. */ }
    }
    key = runner.agent;
  }
  try {
    const result = (await reconcileIntegrations(ctx, { target: key }))[0];
    if (result && (result.state === "conflict" || result.state === "failed")) throw new CoreError("conflict", `Integration ${key} is not ready: ${result.detail}`, result.hint);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("conflict", `Integration ${key} could not be refreshed`, `Run pacer doctor and reconnect the intended account with pacer install ${key}`);
  }
}

/** Used only at actual local process launch, never historical transcript reads. */
export async function ensureProviderIntegration(ctx: Ctx, provider: string): Promise<void> {
  const strategy = loadStrategy(ctx), runner = resolveRunner(strategy, provider);
  if (runner) await ensureRunnerIntegration(ctx, runner);
}
