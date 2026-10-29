import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT } from "../serve/constants";
import { runningWork, workCounts, type RunningWorkCounts } from "./running-work";
import { upgradeSummary } from "../tasks/handover-service";
import { currentVersion } from "../update/version";
import type { Ctx } from "../types";

export const UPGRADE_CLI_REFUSAL = "upgrades are not allowed from a delegated task";
export interface UpgradeDeps { fetch?: (url: string, init?: RequestInit) => Promise<Response>; sleep?: (ms: number) => Promise<void>; healthTimeoutMs?: number; handoverTimeoutMs?: number }
export interface RestartOutcome { restarted: boolean; summary: string | null; warning?: string }
interface HandoverResult { pacer: string; tasks: number; sessions: number; handed_over: number; kept_on_previous_runner: number; summary: string }

async function call<T>(ctx: Ctx, deps: UpgradeDeps, op: string, params: unknown, timeoutMs: number): Promise<T> {
  const token = readFileSync(join(ctx.pacerHome, "token"), "utf8").trim();
  const response = await (deps.fetch ?? fetch)(`http://127.0.0.1:${Number(ctx.env.PACER_PORT ?? DEFAULT_PORT)}/v3/ops/${op}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (!response.ok || body.result === undefined) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body.result;
}

/** The restarted service answers authenticated calls and reports `expected` when one is given. */
export async function waitForService(ctx: Ctx, deps: UpgradeDeps, expected?: string): Promise<string | null> {
  const deadline = Date.now() + (deps.healthTimeoutMs ?? 30_000), sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  do {
    try { const v = await call<{ pacer: string }>(ctx, deps, "version.get", {}, 2000); if (!expected || v.pacer === expected) return v.pacer; }
    catch { /* still restarting */ }
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
}

/**
 * The CLI side of an upgrade: read active work, restart, wait for the new service's health check, then ask
 * that service to hand running work over (it waits up to 60 s) and report what kept running.
 */
export async function restartAroundWork(ctx: Ctx, restart: () => Promise<boolean>, o: { expectedVersion?: string; prefix: (version: string) => string; deps?: UpgradeDeps }): Promise<RestartOutcome> {
  const deps = o.deps ?? {};
  const before: RunningWorkCounts | null = await runningWork(ctx).then(workCounts, () => null);
  if (!await restart()) return { restarted: false, summary: null };
  if (before && !before.tasks && !before.sessions) return { restarted: true, summary: upgradeSummary(o.prefix(o.expectedVersion ?? currentVersion()), { tasks: 0, sessions: 0, keptOnPreviousRunner: 0 }) };
  const version = await waitForService(ctx, deps, o.expectedVersion);
  if (!version) return { restarted: true, summary: null, warning: "the restarted service did not pass its health check; running work stays on its current runners" };
  try {
    const r = await call<HandoverResult>(ctx, deps, "service.handover", { wait_s: 60 }, deps.handoverTimeoutMs ?? 75_000);
    return { restarted: true, summary: upgradeSummary(o.prefix(r.pacer), { tasks: r.tasks, sessions: r.sessions, keptOnPreviousRunner: r.kept_on_previous_runner }) };
  } catch (error) {
    return { restarted: true, summary: null, warning: `running work was not handed over: ${(error as Error).message}` };
  }
}
