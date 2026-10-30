import type { AccountSummary } from "../../../src/api/read-model/types";
import { clock as formatClock } from "../../../src/view-model/time";
import { accountNeedsSignIn } from "../../../src/view-model/words";
export interface Model { id: string; name?: string; context?: number; output?: number; tools?: boolean }
export interface Account {
  usageCheck?: { action: "probe" | "refresh" | "unsupported" | "unmetered"; consentRequired: boolean; description: string };
  name: string; kind: string; folder?: string; source?: string; quotaSource?: string | null; signedIn?: boolean | null; signin_command?: string; runners?: string[];
  state?: string | { state?: string; detail?: string }; detail?: string;
  connection?: { base_url_host?: string; key?: string; models: Model[]; checked_at?: string | number };
  usageReading?: { spendUsd?: number; windows: { name: string; usedPct: number | null; resetsAt: number | null; stale?: boolean }[]; capturedAt?: number | null; stale?: boolean; source?: string; error?: string; availability?: { state: string; reason: string } };
}
/** Reactive read times and local reads are not observations of a quota balance. */
export function accountQuotaLabel(account: Account, summary?: AccountSummary): string | undefined {
  const action = account.usageCheck?.action;
  const source = account.usageReading?.source ?? summary?.source;
  if (action === "unmetered" || source === "unmetered") return "Unmetered";
  if (action === "unsupported" || source === "reactive") return "Quota unavailable";
  return undefined;
}

/** Choose one observation, including its freshness and errors. A newer list read
 * must update the quota too; a newer snapshot must not borrow the list timestamp.
 * Current refresh errors survive selection of retained historical quota. */
export function accountObservation(account: Account, summary?: AccountSummary) {
  if (accountQuotaLabel(account, summary)) return undefined;
  const reading = account.usageReading;
  const summaryTime = summary?.capturedAt ?? -Infinity;
  const readingTime = reading?.capturedAt ?? -Infinity;
  if (!reading || summary && summaryTime > readingTime) {
    return summary ? {usage: reading?.error
      ? {...summary, stale: true, verdict: "unknown", pacePct: null}
      : summary, error: reading?.error} : undefined;
  }
  const window = reading.windows.find(w => ["weekly", "week", "7d", "seven_day"].includes(w.name))
    ?? reading.windows[0];
  // Either response may have aged an observation with this exact timestamp.
  const stale = reading.stale !== false || reading.capturedAt == null || !!reading.error || !!window?.stale
    || reading.capturedAt === summary?.capturedAt && summary?.stale === true;
  const usage: AccountSummary = {
    name: account.name, agent: summary?.agent ?? account.kind, source: reading.source ?? "unknown",
    usedPct: window?.usedPct ?? null, window: window?.name ?? null, resetsAt: window?.resetsAt ?? null,
    capturedAt: reading.capturedAt, stale, pacePct: null, verdict: "unknown",
    signedIn: account.signedIn ?? null, executors: account.runners ?? [],
    spendUsdWeek: reading.spendUsd ?? null, capUsdWeek: summary?.capUsdWeek ?? null,
  };
  // Pacing belongs to the service evaluation of this observation. A newer direct
  // reading has no authoritative verdict yet; percentages cannot supply one.
  if (!stale && reading.capturedAt != null && reading.capturedAt === summary?.capturedAt
    && usage.usedPct === summary.usedPct && usage.window === summary.window
    && usage.resetsAt === summary.resetsAt && usage.spendUsdWeek === summary.spendUsdWeek) {
    usage.verdict = summary.verdict;
    usage.pacePct = summary.pacePct;
  }
  return {usage, error: reading.error};
}

export const arkcliSignInRequired = (account: Account) => account.quotaSource === "arkcli" && account.usageReading?.availability?.reason === "authentication_failed";
export function arkcliRefreshMessage(result: { accounts?: { account: string; outcome: string; error?: string | null }[] }, name: string): string {
  const reading = result.accounts?.find(item => item.account === name);
  if (!reading || reading.outcome === "failed") return reading?.error || "Usage could not be refreshed. Check Ark CLI sign-in and try again.";
  if (reading.outcome === "unsupported") return "Usage refresh is unavailable for this account.";
  return reading.outcome === "updated" ? "New usage observation received." : "No new usage observation. The previous reading is unchanged.";
}
export interface Limit { account: string; capturedAt?: number | null; stale?: boolean; source?: string | null; usedPct?: number | null; window?: string | null; resetsAt?: number | null; error?: string | null; hint?: string | null }
export const clock = (seconds: number) => formatClock(seconds, Date.now() / 1000);
export function accountsModel(accounts: Account[], limits: Limit[]) {
  return accounts.map(account => {
    const limit = limits.find(l => l.account === account.name);
    const captured = limit?.capturedAt ?? account.usageReading?.capturedAt;
    const stale = limit?.stale ?? account.usageReading?.stale;
    return { ...account, signin: accountNeedsSignIn(account) ? signinCommand(account) : undefined,
      windows: (account.usageReading?.windows.length ? account.usageReading.windows : limit?.window ? [{ name: limit.window, usedPct: limit.usedPct ?? null, resetsAt: limit.resetsAt ?? null }] : []).map(w => ({ ...w, tone: legacyWindowTone(w.usedPct) })),
      freshness: captured == null ? "Usage not available yet" : `${stale ? "Stale since" : "Updated"} ${clock(captured)}`,
      source: limit?.source ?? account.usageReading?.source ?? "Unknown source", error: limit?.error, hint: limit?.hint ? limit.hint[0]!.toUpperCase() + limit.hint.slice(1) : limit?.hint };
  });
}

/** Account windows carry no service verdict yet; this keeps the old meter colour until Phase 3 rewrites Accounts on executors[]. */
const legacyWindowTone = (used: number | null): "good" | "bad" => used !== null && used >= 97 ? "bad" : "good";
function signinCommand(account: Account): string | undefined {
  const folder = account.folder?.replace(/\/$/, "");
  if (account.kind === "claude" && folder?.endsWith("/.claude")) return "claude\n# Then run /login to sign in.";
  if (account.kind === "codex" && folder?.endsWith("/.codex")) return "codex login";
  return account.signin_command;
}
