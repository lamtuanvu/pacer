import type { AccountSummary } from "../../../src/api/read-model/types";
import type { UsageState } from "../../../src/types";
import { accountNeedsSignIn } from "../../../src/view-model/words";
export interface Model { id: string; name?: string; context?: number; output?: number; tools?: boolean }
export interface Account {
  usageCheck?: { action: "probe" | "refresh" | "unsupported" | "unmetered"; consentRequired: boolean; description: string };
  name: string; kind: string; folder?: string; source?: string; provider?: string | null; model?: string | null; quotaSource?: string | null; signedIn?: boolean | null; signin_command?: string; runners?: string[];
  state?: string | { state?: string; detail?: string }; detail?: string;
  connection?: { base_url_host?: string; key?: string; models: Model[]; checked_at?: string | number };
  /** The account's one usage record (ADR 0030); every surface renders usageView over it. */
  usageState?: UsageState;
  /** Raw provider readings, diagnostics only (ADR 0030). */
  diagnostics?: { readings?: { availability?: { state: string; reason: string } }[] };
}

/** The account's one usage record: account.list's usageState, with the snapshot's identical record as fallback. */
export const accountRecord = (account: Account, summary?: AccountSummary): UsageState | undefined => account.usageState ?? summary?.usageState;

/** Ark CLI sign-in failures surface from the raw reading's availability, which stays diagnostics. */
export const arkcliSignInRequired = (account: Account) =>
  account.quotaSource === "arkcli" && account.diagnostics?.readings?.[0]?.availability?.reason === "authentication_failed";
export function arkcliRefreshMessage(result: { accounts?: { account: string; outcome: string; error?: string | null }[] }, name: string): string {
  const reading = result.accounts?.find(item => item.account === name);
  if (!reading || reading.outcome === "failed") return reading?.error || "Usage could not be refreshed. Check Ark CLI sign-in and try again.";
  if (reading.outcome === "unsupported") return "Usage refresh is unavailable for this account.";
  return reading.outcome === "updated" ? "New usage observation received." : "No new usage observation. The previous reading is unchanged.";
}
