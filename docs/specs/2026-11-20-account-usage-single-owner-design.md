# Account usage has one owner

Date: 2026-11-20

Status: Proposed. Decision record: [ADR 0030](../decisions/0030-account-usage-single-owner.md).

## Problem

The same account shows different usage on different surfaces at the same moment. On 2026-11-20 the Settings > Agents table showed Cursor as "100% of limit · resets Fri" and "Out of quota", the status bar showed 100%, and the Usage popover showed "0% · Reset unknown · Updated 1s ago". The session-start budget block reported Codex as "observed 206h ago" while the popover said "Updated 1m ago".

[ADR 0002 (executor eligibility)](../decisions/0002-executor-eligibility.md) already requires that "presentation does not decide permission from quota percentages", and [ADR 0002 (idle usage)](../decisions/0002-idle-usage-adapters.md) requires that "the browser, CLI and service need the same account result". The code drifted away from both. An audit of `src/`, `crates/`, `app/` and `plugins/` on 2026-11-20 found the causes below.

### Two pipelines

| Pipeline | Built by | Applies | Consumers |
|---|---|---|---|
| P1 status | `computeStatus` (`src/engine/status.ts`) | reading, limit marks as evidence facts, stored evidence, auth, sign-in, eligibility | hook budget block, `pacer status`, MCP `budget_status`, `limits.check`, `routing.status`, snapshot read model (TS and Rust), TUI, status line, Agents table, status bar, tray, Dispatch |
| P2 account list | `accountListPart` → `readAccountUsage` + `markFreshness` | raw provider reading only | `account.list` (served by Rust, parts from TS), Usage popover, `pacer account list`, Accounts tab, Budget windows, AssistantHost, Dispatch 5h window |

`readUsage()`, the only function that overlaid limit marks on a reading, has no callers. Nothing in P2 sees a limit mark.

### Divergences found

1. **Limit marks.** A reactive account with an active mark is EXHAUSTED in P1 and "limit 0%, fresh" in P2.
2. **Fabricated reactive reading.** `src/plugins/usage-broker.ts` (and an unreachable copy in `plugins/pacer-usage`) returns `{limit, usedPct 0, resetsAt null, capturedAt: now}` for reactive accounts. `markFreshness` never ages it. P2 shows it as a real, current 0%; the app's merge prefers it because its timestamp is always newest.
3. **Account and runner verdicts disagree inside P1.** Execution limits and auth failures are recorded with runner, model and host scope. The account summary uses account-scope facts only, so `accounts[]` says ON_PACE while `providers[]` says EXHAUSTED. `Status.mode` follows the account; the Rust `routing.status` and snapshot take mode from the provider row. TS reports `normal`, Rust reports `emergency`.
4. **Model scope mismatch.** Outcome facts carry `attempt.model`; runner scope uses `runner.model ?? "default"`. A tier that picks another model records facts that never apply.
5. **Evidence age.** "observed Nh ago" is `now - min(observedAt)` over every applicable fact. Availability and spending facts are never pruned, so one 9-day-old `execution_success` fact pins the age even when the quota reading is minutes old.
6. **Process-local caches.** `cachedBase` keeps the last good reading in memory. A one-shot CLI process sees only the error; the service shows "Historical usage". `cacheOnly` status calls (dispatch explain, assistant, task detail) mark every reading stale in a fresh process. `limits.refresh` compares against a `cacheOnly` prior and always reports "updated" from a fresh process.
7. **Freshness rules in six places.** 7200/86400 s caps in `usage/freshness.ts`, `engine/evidence.ts` and `crates/engine`; a flat 86400 s "historical" rule in `view-model/capacity.ts` and `crates/tui/src/model.rs`; a 60 s observation expiry in dispatch; literal `97` next to `EXHAUSTED_PCT`; dispatch candidates exhaust at 100.
8. **Presentation derived per surface.** About 26 app surfaces format usage themselves. There are ten staleness checks, six reset formats (weekday only, `clock`, weekday+time, `toLocaleString`, duration, "back Fri 14:00"), four "unmetered" rules, two verdict-label tables that disagree on UNMETERED/OK, unrounded percentages in the session panel, windows labelled "week" whatever they are, and `executorWeekUsage` combining a runner-binding percentage with the account-binding window and reset.
9. **Rust-specific.** `read-model/capacity.rs` sorts host aliases by bytes while TS and `account-ops` use locale compare, so evidence identities differ when aliases differ in case. `limits.check` and `routing.status` reload strategy after the TS parts were computed. Engine ports of `deadline`, conflicts and `binding_window` differ from TS and are used only by goldens. The status line shows stale percentages.
10. **Dead code.** `readUsage`, `limitWindow`, `app/src/model/accounts.ts` `accountsModel`, `app/src/model/home.ts` `homeModel`, the unreachable reactive branch in `plugins/pacer-usage`.

The file references for each item are listed in the appendix.

## Goals

- Every surface shows the same figure, window, reset, freshness and verdict for an account at the same moment.
- One function computes account and executor usage state. Every operation and client reads its result.
- Absence of a usage figure is a state, never a number.
- A test fails when two surfaces disagree.

## Non-goals

- New usage sources or provider adapters.
- Changes to routing policy, pacing thresholds or verdict semantics beyond removing contradictions.
- Removing protocol v2 compatibility.

## Design

### 1. The usage projection

`computeStatus` already merges readings, limit marks, stored evidence, auth and sign-in. It becomes the only producer of usage state and emits one record per account and one per runner. Rows carry the record as `usageState`: `usage` is already the UsageKind of a provider or an account, so `Status.accounts[]` and `providers[]`, the snapshot's executor, account and planner rows and `account.list` all name the field `usageState`:

```ts
interface UsageState {
  scope: { account: string; runner?: string };
  source: "status-line" | "session-log" | "provider-cli" | "metered" | "reactive" | "unmetered" | "unknown";
  figure: { usedPct: number; window: string; lengthS: number; resetsAt: number | null } | null; // null = no figure
  windows: UsageWindowState[];          // every measured window, each with its own freshness
  limit: { until: number; observedAt: number | null; manual: boolean } | null; // applies to this whole scope
  blockedRunners: { runner: string; model: string; until: number | null; reason: "quota_failure" | "authentication_failed" | "subscription_missing" }[]; // account records only
  observedAt: number | null;            // when the binding fact was observed
  freshness: "fresh" | "historical" | "unknown";
  verdict: Verdict;                     // EXHAUSTED when `limit` is active
  eligibility: Eligibility;             // unchanged evaluator
  spend: { usdWeek: number; capUsdWeek: number | null } | null;
  error: { message: string; at: number } | null;
}
```

Rules:

- **Limit marks apply everywhere.** An active mark or limit fact whose scope covers a record sets that record's `limit`, makes its figure `{usedPct: 100, window: "limit", resetsAt: until}` and sets its verdict to EXHAUSTED. Account-name marks (manual reports, `exhausted.json` keys) cover the account and all its runners.
- **Account state covers its runners.** A runner is blocked when its own record has an active `limit` or an `authentication_failed`/`subscription_missing` availability fact. The account record lists blocked runners in `blockedRunners`. Its verdict is:
  - EXHAUSTED when the account itself has `limit`, or when it has at least one runner and every runner is blocked by a quota failure;
  - otherwise the verdict of its measured figure, with `blockedRunners` shown next to it.
  An account with no runners uses its measured figure only. Auth facts never change a verdict; they change eligibility and appear in `blockedRunners`. "Opposite verdicts" means an account record saying OK, ON_PACE, AHEAD or BEHIND while a fact that applies to all of its runners makes them EXHAUSTED; this cannot happen under these rules.
- **Mode.** An active `modeHold` wins. Otherwise mode follows the verdict of the planner's runner record. A planner without an account (for example `opencode`) or without a record gives `normal`. TS and Rust implement the same rule.
- **Model scope.** Execution facts keep their actual runner, model and host scope, as [ADR 0002](../decisions/0002-executor-eligibility.md) requires. A runner record keeps matching facts for its configured model (`runner.model ?? "default"`), exactly as routing does today. A fact recorded for another model that the runner's tiers can select is not widened to the runner: it appears in the account's `blockedRunners` with its `model`, and only the dispatcher's existing per-model candidate check acts on it. "Every runner is blocked" in the account verdict rule means blocked for its configured model.
- **observedAt is the binding fact's time.** Age shown anywhere is `now - observedAt` of the binding budget fact, or of the newest availability fact when there is no budget fact. `reconcileEvidence` prunes availability and spending facts whose validity ended more than 7 days ago.
- **Reactive and unmetered sources produce no windows.** The broker and the `plugins/pacer-usage` reactive and unmetered branches return `{windows: [], capturedAt: null, stale: false, source}`. The `usage.read` input enum keeps `reactive` and `unmetered`, so there is no plugin protocol change. A reactive account without a limit has `figure: null`, `observedAt: null`, `freshness: "unknown"` and verdict OK; `usageView` labels it "No usage figure". An unmetered account has the same shape with verdict UNMETERED, labelled "Unmetered". The single verdict-label table maps OK to "Available" and UNMETERED to "Unmetered".

### 2. One freshness module

`src/usage/freshness.ts` owns every constant: the per-window cap (7200 s for windows of 6 h or less, else 86400 s), auth and execution lifetimes, the exhaustion threshold, the near-limit threshold, cooldown defaults and observation expiry. `engine/evidence.ts`, dispatch candidates and observations, and the Rust engine read these values. The values live in `src/usage/freshness.constants.json`, which `freshness.ts` imports. A new `cargo xtask gen` target (RUST-5) generates `crates/engine/src/freshness_gen.rs` from that file, and the generator's check mode, run in CI next to the existing targets, fails when the generated file is out of date. `view-model` and the TUI stop computing freshness and read `freshness` from the projection.

Dispatch candidates exhaust at the same threshold as the verdict (97).

### 3. One cache owned by the service

Readings, last good readings and refresh outcomes persist under `PACER_HOME/state/usage/<evidence identity>.json`, keyed by the account's evidence identity rather than its name, so a removed and re-created account does not inherit old readings (the [ADR 0002](../decisions/0002-executor-eligibility.md) lifetime boundary). Account removal deletes the file. Files carry `schemaVersion: 1`.

- Directory mode 0700, files 0600, written to a temp file opened with `wx` and renamed (ARCH-16, SEC-7).
- Writes take the per-account `usage-store` lock used by `withLockSync`, so the service, one-shot CLI processes and Rust bridges never interleave.
- A write happens when the windows, error, availability or source change, or when the stored reading is older than its freshness cap. A new `capturedAt` alone does not cause a write unless the stored one would otherwise turn stale.
- Only the core reads or writes the store (ARCH-1). Rust reaches it through the existing TS bridges.

`cachedBase`, `cacheOnly` and `limits.refresh` read and write this store, so a one-shot CLI process and the service see the same last reading. The in-process memo stays only as a 60 s request de-duplicator.

### 4. Operations

- `snapshot.get`, `limits.check`, `routing.status`, the hook text, `pacer status` and MCP `budget_status` read `UsageState` from status.
- `account.list` returns `usageState: UsageState` taken from the same status computation, plus `diagnostics.readings[]` with the raw provider readings for the Diagnostics and account details views. Both fields are additive. `usageReading` stays for the whole of protocol 3.x as a deprecated field and is removed in protocol 4.0 through the compat adapter (API-2). The CHANGELOG records the deprecation and the removal release. Clients stop reading it in this change.
- `usageReading` changes meaning for reactive and unmetered accounts: it no longer carries an invented `limit` window. The CHANGELOG states this.
- The Rust `account.list` (`crates/account-ops/src/account_list_ops.rs`) passes `usageState` and `diagnostics` through in the same PR that adds them on the TS side, since it copies only named fields.
- The Rust read model and `account-ops` pass `UsageState` through without re-deriving verdicts, labels or freshness. Strategy is passed with the parts (as `account.list` already does) so rows and runners come from one strategy snapshot. Host aliases sort with the same locale compare as TS.
- Dormant Rust engine ports: `deadline`, the conflict check and `binding_window` are aligned with TS and covered by golden tests generated from the TS implementation, because `rank_executors` and `compose_status` sit next to them and a later native cutover would use them.

### 5. One presentation function

`src/view-model/usage.ts` exports `usageView(state, now)`:

```ts
interface UsageView {
  figure: string;       // "68%", "Out of quota", "No usage figure", "Unmetered", "Usage unknown"
  meter: number | null; // 0..100 or null
  window: string;       // "week", "5 h", "limit", "" — from the window, never assumed
  reset: string;        // one format: "resets 14:00", "resets Fri 14:00", "resets 11 Dec"
  freshness: string;    // "Updated 3m ago", "Reading 26h old · refresh", ""
  source: string;       // "Status line", "Provider reading", "Observed limits", ...
  tone: "good" | "warn" | "bad" | "neutral";
  verdictLabel: string; // from one table
}
```

Every app surface, the tray, the narrow top bar and CLI tables use it. These helpers are deleted or reduced to calls into it: `executorWeekUsage`, `accountUsageHistorical`, `accountUsageFreshness`, `accountBudgetStatus`, `accountQuotaLabel`, `accountObservation`, `accountUsageWords`, `plannerCaption`, `plannerBudget`, `meterText`, `resetCaption`, `executorValue`, `budgetLine`, `budgetOf`, the popover's inline formatting and the inline text in WorkPanels, SessionPanel, NewTask, Dispatch and AssistantHost. `verdictWords` and `paceStatus` merge into one table. `app/src/model/accounts.ts` stops merging two sources.

The Rust TUI and status line implement the same function in `crates/tui` with golden parity tests against `usageView` fixtures.

### 6. Guards

- **Cross-surface test.** Fixture states: (a) reactive account with an active limit mark; (b) reactive account without a mark; (c) failed read with an older cached reading; (d) quota reading several days old with a fresh execution fact; (e) runner-scoped limit on one of two runners; (f) 5 h and weekly windows with different freshness. For each, the test checks that `computeStatus`, the snapshot (TS and Rust), `account.list` (TS and Rust), the hook text, `limits.check` and `usageView` for every app surface report the same figure, verdict, reset and freshness.
- **Import rule.** A lint test fails if anything under `app/` or `src/view-model/` (other than `src/view-model/usage.ts`) reads the `usageReading` field, imports the `UsageReading` or `UsageWindow` types from `src/types.ts` or `src/plugins/usage-protocol.ts`, or defines a freshness constant outside `src/usage/freshness.ts`.
- **Live validation.** Seed state (a) to (f) in a sandbox home and record the status bar, popover, Agents table, Accounts tab, Budget and pacing, Dispatch home, tray and TUI side by side (CT-11).

## Delivery

| PR | Scope | Depends on |
|---|---|---|
| 1 | This spec and ADR 0030 | — |
| 2 | Service: projection, scope and mode fixes, reactive without windows, freshness module, persisted usage store, evidence age and pruning, `account.list` `usageState` and `diagnostics` (TS and the Rust pass-through), CLI and hook text, dead TS code, CHANGELOG, contract tests for (a) to (f) | 1 |
| 3 | Rust: pass-through of `UsageState` in the read model, status ops, TUI and status line; identity sort; strategy snapshot; generated freshness constants; engine ports; dispatch candidate threshold | 2 |
| 4 | App: `usageView`, every surface moved to it, merges and helpers deleted, import rule, cross-surface test, canvas check, live validation | 2 (3 for TUI parity) |

## Risks

- Account-level verdicts become stricter where runner limits used to be hidden. Routing uses runner records, so routing does not change; only presentation and mode do.
- Removing the fabricated reactive window changes the content of `usageReading` for reactive and unmetered accounts. Scripts that read a 0% `limit` window will see no windows. The field itself stays until protocol 4.0.
- The persisted usage store adds disk writes when a reading changes or would otherwise turn stale; writes are per account.

## Appendix: file references (2026-11-20)

- Pipelines: `src/engine/status.ts` (`computeStatus`, account budgets around line 135, providers around 166, mode at 211); `src/core/accounts.ts` `accountListPart`; `src/usage/index.ts` `readUsage` (dead), `readAccountUsage`, `cachedBase`; `src/usage/reactive.ts`; `src/usage/freshness.ts`; `src/plugins/usage-broker.ts`; `plugins/pacer-usage/index.ts`.
- Evidence: `src/engine/evidence.ts` (`evidenceDeadline`, `reconcileEvidence`, `readingEvidence`), `src/engine/eligibility.ts` (`evidenceAgeS`), `src/core/evidence.ts` (`recordExecutionEvidence`), `src/tasks/runner.ts` (outcome scope, launch verdict override), `src/executors/availability.ts` (`executorExclusion`).
- Process-local caches: `src/usage/refresh.ts`, `src/core/dispatch.ts`, `src/assistant/service.ts`, `src/core/task-detail.ts`, `src/dispatch/observations.ts`.
- Output: `src/render/hook.ts`, `src/render/text.ts`, `src/view-model/eligibility.ts`, `src/core/limits.ts`, `src/commands/accounts.ts`, `src/mcp/server.ts`, `src/api/read-model/capacity.ts`, `src/api/v2-compat.ts`, `src/view-model/panel.ts`.
- Rust: `crates/account-ops/src/account_list_ops.rs`, `crates/account-ops/src/model.rs`, `crates/read-model/src/capacity.rs`, `crates/read-model/src/snapshot.rs`, `crates/task-ops/src/status_ops.rs`, `crates/engine/src/lib.rs`, `crates/engine/src/status.rs`, `crates/dispatch/src/candidates.rs`, `crates/dispatch/src/status_adapter.rs`, `crates/tui/src/model.rs`, `crates/cli/src/status_line/fields.rs`, `crates/config-ops/src/runner_ops.rs`.
- App: `app/src/shell/StatusBar.tsx`, `app/src/shell/TopBar.tsx`, `app/src/screens/settings/{Executors,Accounts,General,DispatcherSetup}.tsx`, `app/src/screens/dispatch/Dispatch.tsx`, `app/src/tray/{Tray.tsx,model.ts}`, `app/src/shell/panels/WorkPanels.tsx`, `app/src/screens/session/SessionPanel.tsx`, `app/src/screens/new-task/NewTask.tsx`, `app/src/model/{accounts,home,new-task}.ts`, `app/src/shell/assistant/AssistantHost.tsx`, `app/src/screens/setup/steps.tsx`, `app/src/screens/insights/model.ts`, `app/src/screens/needs-you/NeedsYou.tsx`, `src/view-model/{capacity,dispatch,words,selectors,route-explain,diagnostics}.ts`.
