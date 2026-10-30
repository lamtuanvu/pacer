import { expect, test } from "bun:test";
import { accountsModel, arkcliRefreshMessage } from "../app/src/model/accounts";

test("Ark CLI refresh reports the provider outcome instead of a generic save success", () => {
  expect(arkcliRefreshMessage({ accounts: [{ account: "plan", outcome: "failed", error: "Ark CLI sign-in required. Run arkcli auth login." }] }, "plan"))
    .toBe("Ark CLI sign-in required. Run arkcli auth login.");
  expect(arkcliRefreshMessage({ accounts: [{ account: "plan", outcome: "updated" }] }, "plan")).toBe("New usage observation received.");
});
test("unchanged readings are never presented as refreshed", () => {
  expect(arkcliRefreshMessage({accounts:[{account:"plan",outcome:"unchanged"}]},"plan")).toContain("No new usage observation");
});
test("accounts retain all windows and use limits freshness and sign-in facts", () => {
  const rows = accountsModel([{ name: "team", kind: "codex", signedIn: false, signin_command: "codex login", usageReading: { windows: [{ name: "5h", usedPct: 20, resetsAt: 100 }, { name: "7d", usedPct: 40, resetsAt: 200 }] } }], [{ account: "team", stale: true, capturedAt: 50, source: "session-log" }]);
  expect(rows[0]!.windows).toHaveLength(2);
  expect(rows[0]!.freshness).toContain("Stale since");
  expect(rows[0]!.signin).toBe("codex login");
});
test("endpoint details contain only the public host and key presence", () => {
  const row = accountsModel([{ name: "local", kind: "endpoint", connection: { base_url_host: "localhost", key: "missing", models: [{ id: "m" }] } }], [])[0]!;
  expect(row.connection?.key).toBe("missing");
  expect(row.signin).toBeUndefined();
});

test("account windows keep today's meter colours until the settings rewrite", () => {
  const rows = accountsModel([{ name: "team", kind: "codex", usageReading: { windows: [{ name: "5h", usedPct: 97, resetsAt: 1 }, { name: "7d", usedPct: 40, resetsAt: 2 }] } }], []);
  expect(rows[0]!.windows.map(w => w.tone)).toEqual(["bad", "good"]);
});

test("sign-in help is offered only for a native account known to be signed out", () => {
  const rows = accountsModel([
    { name: "unknown", kind: "claude", signedIn: null, signin_command: "claude" },
    { name: "in", kind: "codex", signedIn: true, signin_command: "codex login" },
    { name: "out", kind: "claude", signedIn: false, signin_command: "claude" },
  ], []);
  expect(rows.map(r => r.signin)).toEqual([undefined, undefined, "claude"]);
});

import { accountObservation, accountQuotaLabel, type Account } from "../app/src/model/accounts";
import type { AccountSummary } from "../src/api/read-model/types";
const observedSummary: AccountSummary = {name:"team",agent:"codex",source:"logs",usedPct:20,window:"week",resetsAt:1800003600,capturedAt:1800000000,stale:false,pacePct:30,verdict:"ON_PACE",signedIn:true,executors:[],spendUsdWeek:null,capUsdWeek:null};
const observedAccount: Account = {name:"team",kind:"codex",signedIn:true,usageReading:{windows:[{name:"week",usedPct:20,resetsAt:1800003600}],capturedAt:1800000000,stale:false}};

test("new direct quota cannot inherit the older summary's authoritative pacing", () => {
  const account = structuredClone(observedAccount);
  account.usageReading!.capturedAt = 1800000100;
  account.usageReading!.windows[0]!.usedPct = 100;
  const result = accountObservation(account, observedSummary)!;
  expect(result.usage).toMatchObject({usedPct:100,capturedAt:1800000100,verdict:"unknown",pacePct:null,stale:false});
});
test("failed untimestamped refresh retains historical quota and its current error", () => {
  const result = accountObservation({...observedAccount,usageReading:{windows:[],capturedAt:null,stale:true,error:"Sign in again",availability:{state:"unknown",reason:"authentication_failed"}}}, observedSummary)!;
  expect(result.error).toBe("Sign in again");
  expect(result.usage).toMatchObject({usedPct:20,capturedAt:1800000000,stale:true,verdict:"unknown",pacePct:null});
  expect(observedSummary.stale).toBe(false);
});
test("matching valid observation retains authoritative summary verdict and pace", () => {
  expect(accountObservation(observedAccount, observedSummary)!.usage).toMatchObject({usedPct:20,verdict:"ON_PACE",pacePct:30,stale:false});
});
test("summary-only, direct-only and absent observations remain safe", () => {
  expect(accountObservation({name:"team",kind:"codex"}, observedSummary)!.usage).toMatchObject({verdict:"ON_PACE",pacePct:30});
  expect(accountObservation(observedAccount)!.usage).toMatchObject({usedPct:20,verdict:"unknown",pacePct:null});
  expect(accountObservation({name:"team",kind:"codex"})).toBeUndefined();
});

for (const [action, source, label] of [["unsupported", "reactive", "Quota unavailable"], ["unmetered", "unmetered", "Unmetered"]] as const) {
  test(`${source} readings are not quota observations, by capability or source`, () => {
    for (const [metadata, summarySource] of [
      [{usageCheck:{action, consentRequired:false, description:"Provider explanation"}}, "logs"],
      [{usageReading:{...observedAccount.usageReading!, source}}, "logs"],
      [{}, source],
    ] as const) {
      const account = {...observedAccount, ...metadata};
      const summary = {...observedSummary, source:summarySource};
      expect(accountQuotaLabel(account, summary)).toBe(label);
      expect(accountObservation(account, summary)).toBeUndefined();
    }
  });
}
