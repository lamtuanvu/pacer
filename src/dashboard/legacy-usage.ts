/** The terminal dashboard's usage words, kept byte-identical to the Rust TUI (crates/tui) until
 * both move to the one usageView together (ADR 0030 follow-up). App surfaces must not import this. */
import type { AccountSummary } from "../api/read-model/types";

export function meterText(used: number | null, pace: number | null, style: "full" | "compact"): string {
  if (used === null) return "usage unknown";
  const u = Math.round(used), p = pace === null ? null : Math.round(pace);
  if (style === "compact") return p === null ? `${u}%` : `${u}%·${p}`;
  return p === null ? `${u}% used` : `${u}% used · pace ${p}%`;
}

function accountUsageHistorical(account: AccountSummary, now: number) {
  return (account.usedPct != null || account.spendUsdWeek != null)
    && (account.stale !== false || account.eligibility?.budget === "unknown"
      || account.capturedAt == null || !Number.isFinite(account.capturedAt) || account.capturedAt > now
      || (account.resetsAt != null && account.resetsAt <= now)
      || (account.capturedAt != null && now - account.capturedAt > 86400));
}

export function accountUsageFreshness(account: AccountSummary, now = account.eligibility?.evaluatedAt ?? Date.now()/1000) {
  if (!accountUsageHistorical(account, now)) return null;
  const ageS = account.capturedAt == null || !Number.isFinite(account.capturedAt) || account.capturedAt > now || !account.eligibility ? null
    : Math.max(0, now - account.capturedAt);
  return ageS === null ? "Stale reading · check account usage"
    : `Reading ${ageS < 60 ? `${Math.floor(ageS)}s` : ageS < 3600 ? `${Math.floor(ageS / 60)}m` : `${Math.floor(ageS / 3600)}h`} old`;
}
