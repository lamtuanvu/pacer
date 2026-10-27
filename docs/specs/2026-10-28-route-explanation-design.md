# Route explanation: a read-only "Will go to" preview

Date: 2026-10-28. Status: proposed, awaiting the maintainer's approval. Applies to: `src/api/ops.ts`, `src/api/caller-policy.ts`, `src/core/dispatch.ts`, `src/dispatch/**` (including `enforcement.ts`), `src/engine/rank.ts`, `src/remote/eligibility.ts`, `src/engine/slots.ts`, `src/classify/rules.ts`, `src/view-model/**`, `src/mcp/server.ts`, `src/cli.ts`, `docs/protocol.md`, `docs/protocol.schema.json`, generated Rust protocol types.
Builds on:
- [intelligent work dispatcher](2026-10-24-intelligent-work-dispatcher-design.md) and [ADR 0006](../decisions/0006-intelligent-work-dispatcher.md)
- [dispatcher settings](2026-10-26-dispatcher-settings-design.md)
- [per-project strategy](2026-10-20-per-project-strategy-design.md)
- [attempt token accounting](2026-10-27-attempt-token-accounting-design.md)
- [app redesign](2026-10-27-app-redesign-design.md): the "Start work" composer on the Dispatch home, and its full "New task" form. The approved spec's slice table has no slice for the "Will go to" card yet; this spec closes that data gap, and the maintainer decides which slice delivers it

## Problem

The redesigned "New task" composer has a **Will go to** card. While the user types, it shows which agent pacer would pick, which ladder step picked it, why, what happens if that agent can't take the work, and what the planner would spend. Nothing in the API answers that question in a form a client can show.

Two existing operations come close, and neither fits:

- `routing.route` ranks executors for a kind, and can classify a goal. It knows nothing about the dispatch ladder, models or engines. With a goal and no kind, it may call a configured model classifier, which costs tokens and goes over the network on every keystroke.
- `dispatch.preview` runs the real decision: cached observations, the ladder or plugin engine, and exclusions. It returns the raw `DecisionRequest`, including every observation and candidate. That is too large to send on each keystroke, and its reasons are internal strings, which clients may not show (UI-12). It doesn't classify the kind, cover the user's chosen workspace or a manual override, or say anything about the planner.

## Goals

1. One read-only operation returns everything the "Will go to" card shows: the chosen executor, the ladder step and strategy, the reasons with a pass or fail outcome, the fallbacks with any exclusion reasons, and the planner's cost estimate, or an explicit `unknown`.
2. It computes the routing decision with the same functions the runner uses before admission (`previewDispatch` and its ranking), and names every admission-time factor it does not model, so the user can see why the real dispatch might differ.
3. It never starts, reserves, probes, refreshes or writes anything.
4. It is cheap enough to call again as the draft changes.
5. The CLI and MCP get the same explanation (ARCH-8). No client computes routing itself (ARCH-1).

Non-goals:
- Changing how dispatch decides.
- Pre-start checks of the workspace, such as uncommitted files in the current checkout. Those stay on `dispatch.submit` and its error (see Open decisions).
- Workspace placement. The composer's "Where it runs" choice has no counterpart on `dispatch.submit` today (the runner places work itself), so this op takes no workspace input until submit does (see Open decisions).
- Turning tokens into money. Planner cost is in tokens and in the planner's budget windows, as token accounting defines them.

## Operation

Name: **`dispatch.explain`**. Existing dispatch ops are `dispatch.<verb>`, with `dispatch.<noun>.<verb>` only where there is a noun to scope (`dispatch.config.get`, `dispatch.learning.reset`). Explaining belongs to the dispatch request itself, so the flat name fits. `routing.route` and `dispatch.preview` are left as they are (P4).

### Params

Every field except `repo` and `goal` is optional. The schema is `.strict()`, like `previewInputSchema`.

| Field | Type | Meaning |
|---|---|---|
| `repo` | string, 1–4096 | Repository as `dispatch.submit` accepts it; resolved by `resolvePolicyRepoInput` |
| `goal` | string, 1–20000 | The request text, with `dispatch.submit`'s limit. Only kind detection reads it; it is not passed to the decision, so `previewInputSchema`'s 8000 limit does not apply |
| `kind` | kind id | The kind the user picked. When absent, the kind is detected (see Kind detection) |
| `executor` | id | "Send to a specific agent, this task only". A preference, with the runner's semantics (see Override) |
| `model`, `requirements`, `preferences`, `delegationEnforcement`, `difficulty` | as in `workOptionsSchema` | Passed through unchanged |
| `strategyDraft` | strategy draft, as `strategy.preview` takes it | Explain against an unsaved draft. Used by the dispatcher setup's "Try a task" (slice 7) |

### Result

```ts
interface RouteExplanation {
  schemaVersion: 1;
  revision: string;            // stable hash; see Revision
  at: number;                  // Unix seconds the explanation was computed
  observedAt: number | null;   // oldest observation the decision used
  outcome: "select" | "queue" | "fail" | "override";
  kind: { value: string | null; source: "given" | "detected" | "unknown" };
  strategy: { name: string; draft: boolean; source: "project" | "strategy" | "built-in" };
  engine: { id: string; version: string; fallback?: { from: string; reason: "invalid" | "timeout" } };
  chosen: Choice | null;
  step: { id: string; index: number; skipped: { id: string; reason: ReasonCode }[] } | null;
  reasons: Reason[];           // why the chosen executor, or why nothing was chosen
  fallbacks: Fallback[];       // in the order pacer would try them
  planner: PlannerCost;
  uncertainty: Reason[];       // facts that could change the outcome, such as unknown capacity
}
interface Choice { executor: string; account: string; runner: string; model: { kind: "exact"; id: string } | { kind: "executor-default" }; host: string | null }
interface Reason { code: ReasonCode; outcome: "pass" | "fail" | "info"; subject?: string; facts: Record<string, string | number | boolean | null>; text: string }
interface Fallback { executor: string; account: string; state: "eligible" | "excluded"; step?: string; reason?: Reason }
type PlannerCost =
  | { state: "unknown"; reason: ReasonCode }
  | { state: "estimate"; tokens: { median: number; p80: number }; samples: number; basis: "kind" | "kind+repo"; window: PlannerWindow | null };
interface PlannerWindow { account: string; usedPct: number; pacePct: number | null; mode: string }
```

- **Reasons are codes with facts.** `src/view-model/route-explanation.ts` maps each `code` and its `facts` to plain copy, as UI-12 requires. Examples: `quota_exhausted { resetsAt }`, `capacity_comfortable { headroomPct, pacePct }`, `step_match { stepId, kind }`, `repo_access { host }`, `host_unreachable { host }`, `enforcement_uncertified { agent }`, `override { executor }`. `text` is a plain English sentence for the CLI and MCP, so that those surfaces don't need the view model. The app never shows `text` or `code`.
- **The codes come from the existing exclusion sites.** `rankExecutors`, `buildCandidates`, `enforcementExclusion`, `remoteExclusion` and `slotBlock` return free-text reasons today. This spec has each site return a code and facts alongside its current string, which stays in place for `dispatch.preview` and `routing.route`. The list of codes is generated into `docs/protocol.md`. A new code is an additive change (P4, API-1); clients show a generic "Not available right now" for a code they don't know.
- **`chosen`** is the first ranked choice of a valid proposal. On `queue` and `fail` it is null, and `reasons` says why (for example `no_step_matched`).
- **`fallbacks`** are the rest of the ranked choices, then the candidates excluded for this request with their reasons. An executor the ladder would reach in a later step is listed with that `step`. This is the card's "If it can't" row.
- **`outcome: "override"`.** A requested executor is a preference in the runner (`src/tasks/runner.ts`), and the explanation follows the same rules. `reasons` starts with `override` (info). If the requested executor is eligible, it is `chosen`. If it is blocked by the user or exhausted, the runner refuses the task, so `outcome` is `fail` with that reason. If it is unavailable for any other reason, the runner falls back and records the fallback, so `chosen` is the executor the ladder picks and `reasons` includes `override_unavailable { requested, reason }`.
- **`uncertainty`** carries what `dispatch.preview` reports today, such as capacity unknown or an unresolved executor default model, as reason codes. It always includes `cached_preview`: the preview reads cached observations and reserves nothing, so dispatch may differ. It also names the admission-time factors the explanation doesn't model (see Parity).

### Planner cost

pacer has no estimator today. Token accounting measures planner tokens only once a planner adapter reports them, and until then they are `unknown`. The explanation never makes up a number:

- `estimate` only when at least `dispatch.learning.minSamples` (default 20) comparable reviewed root tasks within `maxAgeDays` have planner coverage `measured`. Comparable means the same kind, and the same repository when it alone has enough samples (`basis`). The figures are the median and the 80th percentile of their planner totals.
- Otherwise `unknown`, with a reason: `planner_not_measured`, `too_few_samples { samples, needed }` or `planner_is_executor` (the planner account is also the chosen executor).
- `window` carries the planner's current used percentage, pace and pacing mode from the cached status, which pacer already knows. It is **not** a projection. The canvas shows "Week 16% → 17%", but converting tokens into a percentage of a vendor's window needs a ratio pacer does not measure, so the projection is left out until it can be measured (see Open decisions).
- Per UI-15, the composer shows the planner's window in one place. The Dispatch home's planner budget region links to it rather than repeating it.

### Revision

`dispatch.preview`'s `observationRevision` hashes placeholder observations stamped with `ctx.now`, so it changes on every call. The explanation's `revision` instead hashes the decision inputs, `strategyHash`, and the observations with `observedAt` and `expiresAt` removed from every observation whose state is not `known`. Two calls over the same facts return the same revision.

### Kind detection

`dispatch.submit` does not classify: it uses the `kind` it is given, or none. The composer shows the detected kind as a chip the user can change, and **sends that kind on submit**, so the preview and the dispatch use the same kind.

With a goal and no `kind`, `routing.route` calls the configured classifier through `decide()`, which may call a model adapter (ollama or jev), runs shadow adapters and appends to the classifier decision log. The explanation must not spend tokens, reach the network or write on every keystroke, so it calls **the rules adapter's pure function directly**, not `decide()`, and `kind.source` is `detected`. It does not call `routing.route` at all. When rules can't decide, `kind` is `{ value: null, source: "unknown" }`, and the ladder runs with a null kind, as `dispatch.submit` would without one.

## Read-only guarantee

`dispatch.explain` starts nothing, reserves nothing, writes nothing, publishes no event and makes no network call. `previewDispatch` as it stands does not meet that bar, so the explanation runs it with these changes, each behind an option that `dispatch.preview` and the runner don't set:

| Path in `previewDispatch` today | Side effect | In `dispatch.explain` |
|---|---|---|
| `enforcementExclusion` under strict enforcement (the default) | Spawns `<agent> --version` for each runner (`src/dispatch/enforcement.ts`) | Uses only an in-memory cache of the last version check, keyed by binary path and modification time. With no cached result, the runner is not excluded; `uncertainty` gets `enforcement_unverified { agent }`. The cache is filled by submit, the runner and `dispatch.enforcement`, never by explain |
| A plugin decision engine | Starting an idle plugin, which publishes `plugin` events | Calls the engine only if its plugin is already `ready`. Otherwise it uses the ladder and reports `engine_not_running` in `engine.fallback` |
| `computeStatus` | Reads usage | `cacheOnly`, with a read-only ctx, as preview already does |
| `remoteExclusion` | SSH probe | Cached reachability only, as preview already does; older than 60 s gives `host_reachability_unknown` |
| `dispatchDatabase()` (learned fit, work lookup) | Runs DDL on open | Opens the store read-only. When the store or its tables don't exist yet, learned fit is skipped and `uncertainty` gets `learning_unavailable` |
| Observation adapters | Could reach the network | Only the stored observations and the cached-status adapter |

It also never calls `dispatch.refresh`, `routing.route`, the classifier's `decide()`, a job, or the enforcement canary.

Tests: one snapshots `PACER_HOME` (files, modes and modification times, and the SQLite store's contents) and the event outbox before and after a burst of explain calls, on an initialized home and on a fresh one, and requires them to be identical. Another runs explain with a `ctx.run` and network stub that fail the test if called.

## Parity with dispatch

The runner decides in two stages: a routing decision (`previewDispatch` with the task's options), then admission. The explanation reproduces the first stage exactly. Admission-time factors that it does not model, and how it reports them:

| Admission factor | In the explanation |
|---|---|
| `delegation.pause` | Read from state. While paused, `outcome` is `queue` with `paused { until }` |
| Capacity reservations of running work (`work_reservations`) | Read from the store, read-only, and subtracted from headroom as `reserveDispatch` does. Any reservation affecting a candidate adds `reserved_capacity` to `uncertainty` |
| Root concurrency limits and slot locks | `slotBlock` from the current running tasks, as preview does. Locks taken between explain and submit can't be seen |
| The difficulty filter hook and `hooks.taskKind` | Not run. `uncertainty` gets `admission_hooks` when either is configured |

The parity test compares the explanation's `chosen` and `fallbacks` with the runner's routing decision for the same fixtures and observations, with no hooks configured and no reservations. It does not claim parity for the factors above.

## Reuse

| Need | Reused from |
|---|---|
| Repository and project policy | `resolvePolicyRepoInput`, `projectSnapshot` (as in `route` and `previewDispatch`) |
| Executor ranking and exclusions | `rankExecutors`, `slotBlock`, `remoteExclusion` (cached), `enforcementExclusion` (cached result only) |
| Candidates, ladder and engine | `buildModelInventory`, `buildCandidates`, `applyLearnedFit`, `runDecision` with the configured engine |
| Draft strategies | `strategy.preview`'s draft materialization (`validateStrategy` on the draft, never written) |
| Planner window | `computeStatus` (cached) and the pacing mode |
| Planner history | token accounting's `root_usage` (planner source) once it exists |

`previewDispatch` is split into a pure `explainInputs` step and a `decide` step, so that `dispatch.preview`, `dispatch.explain` and `dispatch.submit` call the same code. `dispatch.preview` keeps its result shape.

## Errors

No new error codes (API-4). The documented codes are:

| Code | When |
|---|---|
| `invalid_input` | The params fail the schema; an unknown `kind`; `remote` without `host`; an invalid `strategyDraft` (the hint lists the draft's problems, as `strategy.preview` does); a repository whose identity can't be established (`resolvePolicyRepoInput`'s existing error) |
| `unknown_executor` | `executor` names nothing configured |
| `too_large` | The decision input exceeds 256 KiB (`runDecision`'s existing cap) |
| `not_allowed` | The caller is an executor session, with or without an API-5 grant. `dispatch.explain` is added to the caller policy (`src/api/caller-policy.ts`); scoped child work doesn't need it |

A plugin engine failure is not an error. It is reported through `engine.fallback` and the outcome. `outcome: "fail"` is a successful result that says submit would fail; it is not an error.

## Protocol and surfaces

- **Additive (P4, API-1).** A new op in `src/api/ops.ts`. The protocol stays 3.0.0 and the op appears in `hello.ops`. `docs/protocol.md` and `protocol.schema.json` are regenerated (API-3, P11). The reason-code list is generated from one zod enum.
- **Concurrency (P2, ARCH-3).** The op is a read and never conflicts. `revision` lets a client tell whether two explanations are the same. Whether `dispatch.submit` should accept `explainRevision` and report "routing changed since you looked" is an open decision.
- **CLI (ARCH-8).** `pacer route --explain --repo <repo> [--kind <k>] [--goal-file <path> | --goal <text>] [--executor <id>] [--json]` prints the reasons and fallbacks as text, or the result as JSON.
- **MCP.** A planner-side `dispatch_explain` tool beside `dispatch_preview`. Whether to add it is an open decision. It is not offered to grant-scoped executor sessions.
- **Rust.** The op's generated types are regenerated with `cargo xtask gen` in the same PR, since CI runs `cargo xtask gen --check` (CRATE rules). This spec adds no crate.

## Refreshing as the draft changes

The client owns the timing. The service keeps no session state for drafts.

- **Triggers.** Changing the repository, kind, override or a "More options" field refreshes at once. Typing in the request refreshes 400 ms after the last keystroke, and at most once a second while typing continues. Only the goal's effect on kind detection depends on the text, so the service memoizes the decision step by `(strategyHash, observationRevision, decision inputs)` for 5 s in memory. That memo is not persisted.
- **One request in flight.** The client aborts the previous HTTP request (or ignores its JSON-RPC reply) when it sends a new one, keeps a local sequence number, and drops any reply older than the latest it showed.
- **Events.** It refreshes on `executor`, `account`, `planner`, `mode`, `pause`, `host` and `repo` events, and on `config` events whose area is `routing`, `strategy`, `runners` or `accounts`. Bursts are coalesced to one refresh a second.
- **Staleness.** With no refresh for 60 s, for example while the window is hidden, the card marks the preview as possibly out of date and refreshes when the window is visible again. The card shows "Updated as you type" only while refreshes are succeeding.
- **Failure.** On an error, the card keeps the last explanation, marked out of date, with the error in plain words. Submit stays enabled: submit decides for itself, and the preview is advice.
- **Empty draft.** With no goal, the client doesn't call the op and shows "Describe the task to see where it goes".

## View model and UI notes

`src/view-model/route-explanation.ts` builds one `RouteCardView` from the result. The composer renders it:

- The lead row: agent mark, name, "Ladder step N · strategy name" (or "Chosen by you · this task only"), and a status pill from the UI-10 vocabulary.
- The reasons, with ✓, ✕ or ! glyphs next to words (UI-2: never colour alone).
- "If it can't:" lists the fallbacks. An excluded fallback shows its reason on hover and focus, not as struck-through text alone.
- The planner row shows "Planner: not measured yet" for `unknown`, never a zero or a dash pretending to be a value (UI-6, token accounting).
- A detected kind is labelled "detected" until the user confirms or changes it.

## Validation

- Unit tests for every outcome (`select`, `queue`, `fail`, `override`), step skipping, engine fallback, `strategyDraft`, kind detection with a model classifier configured (no model adapter is called), and each planner-cost state.
- The parity test and the read-only tests described above.
- Protocol doc freshness (API-3).
- CT-11 live validation when it ships: drive the composer against real executors with one exhausted executor (the canvas's "Executor out" state), a manual override of an eligible and of an exhausted executor, and a paused dispatcher, then submit and confirm the dispatched executor matches the preview. Executors not exercised live are reported as UNVERIFIED.

## Governance

Constitution 0.15.0. Applicable: P1–P4, P13; ARCH-1–3, ARCH-5, ARCH-8, ARCH-12; API-1–5; UI-6, UI-10, UI-12, UI-13, UI-15; CT-11; REPO-2, REPO-3, REPO-7. No rule changes, so no amendment. No ADR: this is an additive read over decisions ADR 0006 already records.

## Open decisions

For the maintainer. Each has a proposal, but none is assumed.

1. **New op or additive fields.** This spec proposes `dispatch.explain`. The alternative is to add an `explanation` field to `dispatch.preview`. That keeps one op, but keeps the heavy `request` payload on every keystroke.
2. **Planner cost projection.** Should pacer ever show "week 16% → 17%"? That needs a measured tokens-to-percent ratio per planner window. The proposal: no, until a planner adapter reports both.
3. **Estimate threshold.** Reuse `learning.minSamples` (20), or give the planner estimate its own threshold?
4. **Model classifier in the composer.** When a model classifier is configured, should the composer offer an explicit "Detect kind" action that calls it once (spending its tokens), or rely on the rules adapter only?
5. **Submit drift check.** Should `dispatch.submit` accept `explainRevision` and return an additive `routingChanged: true` (not an error) when the decision differs from the one shown?
6. **Workspace placement.** Should `dispatch.submit` gain a workspace option (new worktree, current checkout, a named host) to match the composer? Explain would then take the same input.
7. **Workspace pre-checks.** Should explain also report start blockers, such as uncommitted files in the current checkout, which the canvas shows only after a failed start? That needs a read of the worktree's git state on every refresh.
8. **MCP exposure.** Add `dispatch_explain` for planners, or keep MCP on `dispatch_preview`?
