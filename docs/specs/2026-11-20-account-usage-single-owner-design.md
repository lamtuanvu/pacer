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

The full inventory with file references is kept with the review records for this change.

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

`computeStatus` already merges readings, limit marks, stored evidence, auth and sign-in. It becomes the only producer of usage state and emits one record per account and one per runner:

```ts
interface UsageState {
  scope: { account: string; runner?: string };
  source: "status-line" | "session-log" | "provider-cli" | "metered" | "reactive" | "unmetered" | "unknown";
  figure: { usedPct: number; window: string; lengthS: number; resetsAt: number | null } | null; // null = no figure
  windows: UsageWindowState[];          // every measured window, each with its own freshness
  limit: { until: number; observedAt: number | null; manual: boolean; scopeLabel: string | null } | null;
  observedAt: number | null;            // when the binding fact was observed
  freshness: "fresh" | "historical" | "unknown";
  verdict: Verdict;                     // EXHAUSTED when `limit` is active
  eligibility: Eligibility;             // unchanged evaluator
  spend: { usdWeek: number; capUsdWeek: number | null } | null;
  error: { message: string; at: number } | null;
}
```

Rules:

- **Limit marks apply everywhere.** An active mark or limit fact sets `limit`, makes the figure `{usedPct: 100, window: "limit", resetsAt: until}` for the scopes it covers and sets the verdict to EXHAUSTED.
- **Account state covers its runners.** An account-scope record takes account facts plus every runner-scoped limit or auth fact. If every runner of the account is blocked, the account is blocked. If some are, the account record keeps its measured figure and lists the blocked runners in `limit.scopeLabel` (for example "auto model"). The account and runner records never report opposite verdicts for the same fact.
- **Mode follows the planner runner.** `Status.mode` comes from the planner's runner record in both TS and Rust.
- **Model scope.** Execution facts are recorded with the runner's configured model key (`runner.model ?? "default"`); the attempt model is kept as a detail on the fact.
- **observedAt is the binding fact's time.** Age shown anywhere is `now - observedAt` of the binding budget fact, or of the newest availability fact when there is no budget fact. `reconcileEvidence` prunes availability and spending facts whose validity ended more than 7 days ago.
- **Reactive and unmetered sources produce no windows.** The broker returns `{windows: [], capturedAt: null, source}`. A reactive account without a limit has `figure: null` and `freshness: "fresh"` with verdict OK. The unreachable plugin branch is deleted.

### 2. One freshness module

`src/usage/freshness.ts` owns every constant: the per-window cap (7200 s for windows of 6 h or less, else 86400 s), auth and execution lifetimes, the exhaustion threshold, the near-limit threshold, cooldown defaults and observation expiry. `engine/evidence.ts`, dispatch candidates and observations, and the Rust engine read these values. Rust gets them through generated constants with a parity test. `view-model` and the TUI stop computing freshness and read `freshness` from the projection.

Dispatch candidates exhaust at the same threshold as the verdict (97).

### 3. One cache owned by the service

Readings, last good readings and refresh outcomes persist under `PACER_HOME/state/usage/` (per-account JSON, atomic writes, mode 0600). `cachedBase`, `cacheOnly` and `limits.refresh` read and write this store, so a one-shot CLI process and the service see the same last reading. The in-process memo stays only as a 60 s request de-duplicator.

### 4. Operations

- `snapshot.get`, `limits.check`, `routing.status`, the hook text, `pacer status` and MCP `budget_status` read `UsageState` from status.
- `account.list` returns `usage: UsageState` taken from the same status computation, plus `diagnostics.readings[]` with the raw provider readings for the Diagnostics and account details views. `usageReading` stays in protocol 3.x as a deprecated alias with the raw reading and is removed one minor release later. Clients stop reading it in this change.
- The Rust read model and `account-ops` pass `UsageState` through without re-deriving verdicts, labels or freshness. Strategy is passed with the parts (as `account.list` already does) so rows and runners come from one strategy snapshot. Host aliases sort with the same locale compare as TS.
- Dormant Rust engine ports (`deadline`, conflicts, `binding_window`) are aligned with TS by golden tests or deleted if nothing needs them.

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
- **Import rule.** A lint test fails if anything under `app/` or `src/view-model/` reads `usageReading`, raw `windows`, or freshness constants outside `src/usage/freshness.ts`.
- **Live validation.** Seed state (a) to (f) in a sandbox home and record the status bar, popover, Agents table, Accounts tab, Budget and pacing, Dispatch home, tray and TUI side by side (CT-11).

## Delivery

| PR | Scope | Depends on |
|---|---|---|
| 1 | This spec and ADR 0030 | — |
| 2 | Service: projection, scope and mode fixes, reactive without windows, freshness module, persisted usage store, evidence age and pruning, `account.list` `usage`, CLI and hook text, dead TS code, contract tests for (a) to (f) | 1 |
| 3 | Rust: pass-through of `UsageState` in read model, account-ops, status ops, TUI and status line; identity sort; strategy snapshot; freshness constants; engine ports | 2 |
| 4 | App: `usageView`, every surface moved to it, merges and helpers deleted, import rule, cross-surface test, canvas check, live validation | 2 (3 for TUI parity) |

## Risks

- Account-level verdicts become stricter where runner limits used to be hidden. Routing uses runner records, so routing does not change; only presentation and mode do.
- Removing the fabricated reactive window changes `account.list` for plugins and scripts that read `usageReading`. The deprecated alias keeps the field for one minor release.
- The persisted usage store adds disk writes on every reading; writes are per account and only when the reading changes.
