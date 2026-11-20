import { expect, test } from "bun:test";
import { accountRecord, arkcliRefreshMessage, arkcliSignInRequired, type Account } from "../app/src/model/accounts";
import type { AccountSummary } from "../src/api/read-model/types";
import type { UsageState } from "../src/types";

test("Ark CLI refresh reports the provider outcome instead of a generic save success", () => {
  expect(arkcliRefreshMessage({ accounts: [{ account: "plan", outcome: "failed", error: "Ark CLI sign-in required. Run arkcli auth login." }] }, "plan"))
    .toBe("Ark CLI sign-in required. Run arkcli auth login.");
  expect(arkcliRefreshMessage({ accounts: [{ account: "plan", outcome: "updated" }] }, "plan")).toBe("New usage observation received.");
});
test("unchanged readings are never presented as refreshed", () => {
  expect(arkcliRefreshMessage({accounts:[{account:"plan",outcome:"unchanged"}]},"plan")).toContain("No new usage observation");
});

const record: UsageState = {
  scope: { account: "team" }, source: "provider-cli",
  figure: { usedPct: 20, window: "weekly", lengthS: 7 * 86400, resetsAt: 1800003600 },
  windows: [], limit: null, blockedRunners: [], observedAt: 1800000000, freshness: "fresh",
  verdict: "ON_PACE",
  eligibility: { state: "eligible", reasons: [], evaluatedAt: 1800000000, validUntil: null, evidenceAgeS: 0, availability: "ready", budget: "permitted", spendingRisk: "unknown" },
  spend: null, error: null,
};

test("the account's one usage record comes from account.list, with the identical snapshot record as fallback", () => {
  const summary = { name: "team", agent: "codex", source: "logs", usedPct: 20, window: "week", resetsAt: 1800003600, capturedAt: 1800000000, stale: false, pacePct: 30, verdict: "ON_PACE", signedIn: true, executors: [], spendUsdWeek: null, capUsdWeek: null } as AccountSummary;
  expect(accountRecord({ name: "team", kind: "codex", usageState: record }, summary)).toBe(record);
  expect(accountRecord({ name: "team", kind: "codex" }, summary)).toBe(summary.usageState);
  expect(accountRecord({ name: "team", kind: "codex" })).toBeUndefined();
});

test("Ark CLI sign-in failures surface from the diagnostics reading, not the deprecated usageReading", () => {
  const account: Account = { name: "byteplus", kind: "endpoint", quotaSource: "arkcli",
    diagnostics: { readings: [{ availability: { state: "unknown", reason: "authentication_failed" } }] } };
  expect(arkcliSignInRequired(account)).toBe(true);
  expect(arkcliSignInRequired({ ...account, quotaSource: null })).toBe(false);
  expect(arkcliSignInRequired({ ...account, diagnostics: { readings: [{ availability: { state: "ready", reason: "ok" } }] } })).toBe(false);
});
