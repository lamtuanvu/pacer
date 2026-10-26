import { clock as formatClock } from "../../../src/view-model/time";
import { accountNeedsSignIn } from "../../../src/view-model/words";
export interface Model { id: string; name?: string; context?: number; output?: number; tools?: boolean }
export interface Account {
  name: string; kind: string; folder?: string; source?: string; quotaSource?: string | null; signedIn?: boolean | null; signin_command?: string; runners?: string[];
  state?: string | { state?: string; detail?: string }; detail?: string;
  connection?: { base_url_host?: string; key?: string; models: Model[]; checked_at?: string | number };
  usageReading?: { windows: { name: string; usedPct: number | null; resetsAt: number | null }[]; capturedAt?: number | null; stale?: boolean; source?: string; error?: string; availability?: { state: string; reason: string } };
}
export const arkcliSignInRequired = (account: Account) => account.quotaSource === "arkcli" && account.usageReading?.availability?.reason === "authentication_failed";
export function arkcliRefreshMessage(result: { accounts?: { account: string; outcome: string; error?: string | null }[] }, name: string): string {
  const reading = result.accounts?.find(item => item.account === name);
  if (!reading || reading.outcome === "failed") return reading?.error || "Usage could not be refreshed. Check Ark CLI sign-in and try again.";
  if (reading.outcome === "unsupported") return "Usage refresh is unavailable for this account.";
  return "Usage refreshed.";
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
