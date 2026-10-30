import type { AccountCfg } from "../config/accounts";
import { loadStrategy } from "../config/strategy";
import { startJob, type Job } from "../jobs/registry";
import type { Ctx } from "../types";
import { readAccountUsage, usageRefreshCapability } from "../usage";
import { refreshAccountUsage } from "../usage/refresh";
import { probeClaudeUsage } from "../usage/claude-probe";
import { redactEndpointError } from "../endpoints/state";
import { CoreError } from "./errors";

export interface AccountUsageCapability {
  action: "probe" | "refresh" | "unsupported" | "unmetered";
  consentRequired: boolean;
  description: string;
}
export function accountUsageCapability(account: AccountCfg): AccountUsageCapability {
  if (account.usage === "unmetered") return {action: "unmetered", consentRequired: false, description: "Unmetered. This account has no quota to check."};
  if (account.kind === "claude" && account.usage === "quota") return {action: "probe", consentRequired: true, description: "Runs a small Claude Code task using this account’s quota to collect new usage telemetry."};
  if (usageRefreshCapability(account) !== "unavailable") return {action: "refresh", consentRequired: false, description: "Reads the provider’s available usage source. Old observations remain historical."};
  return {action: "unsupported", consentRequired: false, description: "Only limit hits are observable for this account. A current quota balance is unavailable."};
}
export interface AccountUsageCheckDeps {
  probe?: typeof probeClaudeUsage;
  read?: typeof readAccountUsage;
  refresh?: typeof refreshAccountUsage;
  onDone?: () => Promise<void>;
}
/** Account-owned checks do not create or select a routable executor. */
export async function checkAccountUsage(ctx: Ctx, name: string, consent = false, deps: AccountUsageCheckDeps = {}): Promise<Job> {
  const strategy = loadStrategy(ctx), account = strategy.accounts[name];
  if (!account) throw new CoreError("invalid_input", `Unknown account ${name}`);
  const capability = accountUsageCapability(account);
  if (capability.action === "unsupported" || capability.action === "unmetered") throw new CoreError("not_allowed", capability.description);
  if (capability.consentRequired && !consent) throw new CoreError("not_allowed", "This usage check consumes account quota. Confirm Run usage check to continue.");
  return startJob(ctx, "account.usage.check", name, ["Check usage"], async step => {
    step.start("Check usage", capability.action === "probe" ? "Running a small task to collect new telemetry" : "Reading provider usage");
    try {
      if (capability.action === "probe") {
        const runners = Object.values(strategy.runners).filter(r => r.account === name);
        const read = deps.read ?? readAccountUsage;
        const prior = await read(ctx, account, runners, false, false, strategy.hosts);
        await (deps.probe ?? probeClaudeUsage)(ctx, account);
        const current = await read({...ctx, now: Math.max(ctx.now, Date.now()/1000)}, account, runners, true, false, strategy.hosts);
        if (current.error) throw new CoreError("not_allowed", current.error);
        if (current.stale || !current.windows.some(w => w.usedPct !== null) || current.capturedAt === null || current.capturedAt <= (prior.capturedAt ?? -Infinity)) {
          throw new CoreError("not_allowed", "No new usage observation from Claude Code. The previous reading is unchanged. Update Claude Code, check this account’s subscription and try again.");
        }
        step.pass("Check usage", "New usage observation received.");
      } else {
        const result = await (deps.refresh ?? refreshAccountUsage)(ctx, name);
        if (result.outcome === "failed" || result.error) throw new CoreError("not_allowed", result.error ?? "Usage check failed. Check provider sign-in and try again.");
        if (result.outcome === "unsupported") throw new CoreError("not_allowed", capability.description);
        if (result.outcome === "updated") step.pass("Check usage", "New usage observation received.");
        else step.skip("Check usage", "No new usage observation. The previous reading is unchanged.");
      }
    } catch(error) {
      const secrets=Object.entries(ctx.env).filter(([key])=>/key|token|secret|password/i.test(key)).map(([,value])=>value??"");
      const message=redactEndpointError(error instanceof Error?error.message:String(error),secrets);
      step.fail("Check usage",message);
      throw new CoreError(error instanceof CoreError?error.code:"not_allowed",message);
    } finally {
      await deps.onDone?.();
    }
  });
}
